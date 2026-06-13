import express from 'express';
import dotenv from 'dotenv';
import { Jetstream } from '@skyware/jetstream';
import { initDb, savePost, getFeed, pruneOldPosts } from './db.js';
import { shouldIncludePost } from './filter.js';

dotenv.config();

const port = process.env.FEEDGEN_PORT || 3000;
const hostname = process.env.FEEDGEN_HOSTNAME || 'localhost';
const publisherDid = process.env.FEEDGEN_PUBLISHER_DID || 'did:plc:placeholder';
const feedGenDid = `did:web:${hostname}`;
const feedRecordKey = 'thoughts-and-memes';
const feedUri = `at://${publisherDid}/app.bsky.feed.generator/${feedRecordKey}`;

// Initialize DB
initDb();

const app = express();

// 1. Resolve DID Document (for did:web verification)
app.get('/.well-known/did.json', (req, res) => {
  if (hostname === 'localhost') {
    return res.status(400).json({ error: 'Configure FEEDGEN_HOSTNAME to resolve DID document' });
  }
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    'id': feedGenDid,
    'service': [
      {
        'id': '#bsky_fg',
        'type': 'BskyFeedGenerator',
        'serviceEndpoint': `https://${hostname}`
      }
    ]
  });
});

// 2. Describe Feed Generator
app.get('/xrpc/app.bsky.feed.describeFeedGenerator', (req, res) => {
  res.json({
    did: feedGenDid,
    feeds: [
      {
        uri: feedUri
      }
    ]
  });
});

// 3. Get Feed Skeleton
app.get('/xrpc/app.bsky.feed.getFeedSkeleton', (req, res) => {
  const feedParam = req.query.feed as string;
  const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const cursorParam = req.query.cursor as string;

  if (feedParam !== feedUri) {
    return res.status(400).json({ error: 'Unsupported feed URI' });
  }

  try {
    const result = getFeed(limitParam, cursorParam);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching feed skeleton:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start HTTP Server
app.listen(port, () => {
  console.log(`[Server] Feed Generator running on http://localhost:${port}`);
  console.log(`[Server] DID: ${feedGenDid}`);
  console.log(`[Server] Feed URI: ${feedUri}`);
});

// Start Jetstream Client
console.log('[Jetstream] Subscribing to Bluesky post stream...');
const jetstream = new Jetstream({
  wantedCollections: ['app.bsky.feed.post'],
  endpoint: 'wss://jetstream1.us-east.bsky.network/subscribe'
});

jetstream.onCreate('app.bsky.feed.post', (event) => {
  const post = event.commit.record;
  const author = event.did;
  const uri = `at://${author}/${event.commit.collection}/${event.commit.rkey}`;
  const cid = event.commit.cid;

  try {
    if (shouldIncludePost(post)) {
      savePost(uri, cid, author, post.text || '');
      console.log(`[Jetstream] Included post: "${(post.text || '').substring(0, 50).replace(/\n/g, ' ')}..." by ${author}`);
    }
  } catch (err) {
    console.error('[Jetstream] Error processing post:', err);
  }
});

jetstream.on('error', (err) => {
  console.error('[Jetstream] Connection error:', err);
});

jetstream.on('close', () => {
  console.log('[Jetstream] Connection closed. Reconnecting...');
});

jetstream.start();

// Prune database hourly (keep posts for 48 hours)
setInterval(() => {
  try {
    pruneOldPosts(48);
  } catch (err) {
    console.error('[DB] Error during prune:', err);
  }
}, 60 * 60 * 1000);
export {};

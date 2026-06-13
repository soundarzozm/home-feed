import express from 'express';
import dotenv from 'dotenv';
import { Jetstream } from '@skyware/jetstream';
import { BskyAgent } from '@atproto/api';
import { initDb, savePost, saveLike, getPersonalizedFeed, pruneOldPosts } from './db.js';
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

// Set up Bsky Agent for follows lookup
const agent = new BskyAgent({ service: 'https://bsky.social' });
let isAgentLoggedIn = false;

async function loginAgent() {
  const handle = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_PASSWORD;
  if (handle && password) {
    try {
      await agent.login({ identifier: handle, password });
      isAgentLoggedIn = true;
      console.log(`[Agent] Authenticated as ${handle} for user relationship queries`);
    } catch (err) {
      console.error('[Agent] Authentication failed:', err);
    }
  } else {
    console.log('[Agent] No BSKY_HANDLE or BSKY_PASSWORD in .env. Personalization will be mock/empty.');
  }
}
loginAgent();

// Keep track of followed DIDs from active users so Jetstream knows whose likes to index
const followsCache = new Map<string, { dids: Set<string>; fetchedAt: number }>();
const activeFollowedDids = new Set<string>();

function updateActiveFollowedDids() {
  activeFollowedDids.clear();
  for (const cacheEntry of followsCache.values()) {
    for (const did of cacheEntry.dids) {
      activeFollowedDids.add(did);
    }
  }
}

async function getFollowedDids(requesterDid: string): Promise<Set<string>> {
  const cached = followsCache.get(requesterDid);
  const cacheDurationMs = 15 * 60 * 1000; // Cache for 15 minutes

  if (cached && (Date.now() - cached.fetchedAt < cacheDurationMs)) {
    return cached.dids;
  }

  const followedDids = new Set<string>();
  if (!isAgentLoggedIn) {
    return followedDids;
  }

  try {
    let cursor: string | undefined;
    // Query up to 500 follows
    for (let i = 0; i < 5; i++) {
      const response = await agent.app.bsky.graph.getFollows({
        actor: requesterDid,
        limit: 100,
        cursor: cursor
      });
      for (const follow of response.data.follows) {
        followedDids.add(follow.did);
      }
      cursor = response.data.cursor;
      if (!cursor) break;
    }

    followsCache.set(requesterDid, { dids: followedDids, fetchedAt: Date.now() });
    updateActiveFollowedDids();
    console.log(`[Cache] Updated follows for ${requesterDid}. Count: ${followedDids.size}. Active DIDs in set: ${activeFollowedDids.size}`);
  } catch (err) {
    console.error(`[Cache] Error fetching follows for ${requesterDid}:`, err);
  }

  return followedDids;
}

// Extract requester DID from JWT (caller credentials)
function getRequesterDid(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.iss || null;
  } catch (err) {
    console.error('[Auth] Failed to parse requester JWT:', err);
    return null;
  }
}

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

// 3. Get Feed Skeleton (Personalized)
app.get('/xrpc/app.bsky.feed.getFeedSkeleton', async (req, res) => {
  const feedParam = req.query.feed as string;
  const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const cursorParam = req.query.cursor as string;

  if (feedParam !== feedUri) {
    return res.status(400).json({ error: 'Unsupported feed URI' });
  }

  try {
    const requesterDid = getRequesterDid(req);
    let followedDids = new Set<string>();

    if (requesterDid) {
      followedDids = await getFollowedDids(requesterDid);
    } else {
      console.log('[Auth] Unauthenticated request received. Serving fallback public feed.');
    }

    const result = getPersonalizedFeed(followedDids, limitParam, cursorParam);
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

// Start Jetstream Client (listening to both posts and likes)
console.log('[Jetstream] Subscribing to Bluesky post/like stream...');
const jetstream = new Jetstream({
  wantedCollections: ['app.bsky.feed.post', 'app.bsky.feed.like'],
  endpoint: 'wss://jetstream1.us-east.bsky.network/subscribe'
});

// Handle Posts (both original and replies)
jetstream.onCreate('app.bsky.feed.post', (event) => {
  const post = event.commit.record;
  const author = event.did;
  const uri = `at://${author}/${event.commit.collection}/${event.commit.rkey}`;
  const cid = event.commit.cid;

  try {
    const { shouldInclude, isReply } = shouldIncludePost(post);
    if (shouldInclude) {
      savePost(uri, cid, author, post.text || '', isReply);
      if (!isReply) {
        console.log(`[Jetstream] Post: "${(post.text || '').substring(0, 45).replace(/\n/g, ' ')}..." by ${author}`);
      }
    }
  } catch (err) {
    console.error('[Jetstream] Error processing post:', err);
  }
});

// Handle Likes (Only store if liked by someone our active users follow)
jetstream.onCreate('app.bsky.feed.like', (event) => {
  const like = event.commit.record;
  const likerDid = event.did;
  const postUri = like.subject?.uri;

  if (postUri && activeFollowedDids.has(likerDid)) {
    try {
      saveLike(postUri, likerDid);
      console.log(`[Jetstream] Like: Saved like on ${postUri} by followed user ${likerDid}`);
    } catch (err) {
      console.error('[Jetstream] Error processing like:', err);
    }
  }
});

jetstream.on('error', (err) => {
  console.error('[Jetstream] Connection error:', err);
});

jetstream.on('close', () => {
  console.log('[Jetstream] Connection closed. Reconnecting...');
});

jetstream.start();

// Prune database hourly (keep posts/likes for 48 hours)
setInterval(() => {
  try {
    pruneOldPosts(48);
  } catch (err) {
    console.error('[DB] Error during prune:', err);
  }
}, 60 * 60 * 1000);

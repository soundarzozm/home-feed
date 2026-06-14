import express from 'express';
import dotenv from 'dotenv';
import { Jetstream } from '@skyware/jetstream';
import { BskyAgent } from '@atproto/api';
import { 
  initDb, 
  queuePost, 
  queueLike, 
  queueRepost,
  queueReply,
  flushQueue, 
  getPersonalizedFeed, 
  pruneOldPosts,
  saveFollows,
  loadAllFollowedDids,
  getCachedFollowedDids,
  getPostTextLocal,
  loadRecentPostUris,
  getAuthorReputations,
  getRecentPostUrisForSync,
  updatePostEngagementCounts
} from './db.js';
import { shouldIncludePost, isTextClean } from './filter.js';

dotenv.config();

const port = process.env.FEEDGEN_PORT || 3000;
const hostname = process.env.FEEDGEN_HOSTNAME || 'localhost';
const publisherDid = process.env.FEEDGEN_PUBLISHER_DID || 'did:plc:placeholder';
const feedGenDid = `did:web:${hostname}`;
const feedRecordKey = 'thoughts-and-memes';
const feedUri = `at://${publisherDid}/app.bsky.feed.generator/${feedRecordKey}`;

// Initialize DB and load cached follows into memory
initDb();
const activeFollowedDids = loadAllFollowedDids();

// Keep a memory cache of the recently indexed post URIs to capture global engagement
const indexedPostsCache = new Set<string>();
const maxCacheSize = 50000;
const indexedPostsQueue: string[] = [];

function trackIndexedPost(uri: string) {
  if (!indexedPostsCache.has(uri)) {
    indexedPostsCache.add(uri);
    indexedPostsQueue.push(uri);
    if (indexedPostsQueue.length > maxCacheSize) {
      const oldest = indexedPostsQueue.shift();
      if (oldest) indexedPostsCache.delete(oldest);
    }
  }
}

// Pre-populate cache with existing post URIs from the database
const recentUris = loadRecentPostUris(maxCacheSize);
for (const uri of recentUris) {
  trackIndexedPost(uri);
}
console.log(`[Cache] Pre-populated indexed post cache with ${indexedPostsCache.size} URIs.`);

// Background Author Reputation Crawler (Anti-Spam & Creator Boosts)
let authorReputations = new Map<string, { avgEngagement: number; postCount: number }>();

function updateAuthorReputations() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    authorReputations = getAuthorReputations(cutoff);
    console.log(`[Reputation] Updated reputations for ${authorReputations.size} authors.`);
  } catch (err) {
    console.error('[Reputation] Error updating author reputations:', err);
  }
}

// Initial calculation and cron update every 5 minutes
updateAuthorReputations();
setInterval(updateAuthorReputations, 5 * 60 * 1000);

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

// Background Recommender Sync (fetches actual like/repost/reply counts from Bluesky API)
async function syncPostEngagements() {
  if (!isAgentLoggedIn) return;
  
  try {
    const uris = getRecentPostUrisForSync(500); // sync last 500 posts
    if (uris.length === 0) return;
    
    console.log(`[Sync] Syncing engagements for ${uris.length} posts with Bluesky AppView...`);
    
    // Batch in chunks of 25 (AppView getPosts limit)
    for (let i = 0; i < uris.length; i += 25) {
      const chunk = uris.slice(i, i + 25);
      const response = await agent.app.bsky.feed.getPosts({ uris: chunk });
      
      for (const p of response.data.posts) {
        updatePostEngagementCounts(
          p.uri, 
          p.likeCount ?? 0, 
          p.repostCount ?? 0, 
          p.replyCount ?? 0
        );
      }
      
      // Small sleep to avoid hammering the AppView API too fast
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log('[Sync] Engagement sync completed successfully.');
  } catch (err) {
    console.error('[Sync] Error syncing engagements:', err);
  }
}

// Bootstrap on startup (wait 5s for database/auth stability) and run every 10 minutes
setTimeout(() => {
  syncPostEngagements().catch(console.error);
}, 5000);
setInterval(() => {
  syncPostEngagements().catch(console.error);
}, 10 * 60 * 1000);

// In-Memory cache for follows list (backed by database follows table)
const followsCache = new Map<string, { dids: Set<string>; fetchedAt: number }>();

async function getFollowedDids(requesterDid: string): Promise<Set<string>> {
  // Check memory cache first
  const cached = followsCache.get(requesterDid);
  const cacheDurationMs = 15 * 60 * 1000; // Cache for 15 minutes

  if (cached && (Date.now() - cached.fetchedAt < cacheDurationMs)) {
    return cached.dids;
  }

  // Fallback to database cache if offline or API is down
  let followedDids = getCachedFollowedDids(requesterDid);

  if (!isAgentLoggedIn) {
    // If agent not logged in, return whatever is in DB
    if (followedDids.size > 0) {
      followsCache.set(requesterDid, { dids: followedDids, fetchedAt: Date.now() });
    }
    return followedDids;
  }

  try {
    const freshFollowedDids = new Set<string>();
    let cursor: string | undefined;

    // Fetch up to 500 follows
    for (let i = 0; i < 5; i++) {
      const response = await agent.app.bsky.graph.getFollows({
        actor: requesterDid,
        limit: 100,
        cursor: cursor
      });
      for (const follow of response.data.follows) {
        freshFollowedDids.add(follow.did);
      }
      cursor = response.data.cursor;
      if (!cursor) break;
    }

    if (freshFollowedDids.size > 0) {
      followedDids = freshFollowedDids;
      // Save follows to DB
      saveFollows(requesterDid, Array.from(followedDids));
      // Re-populate memory follows cache
      followsCache.set(requesterDid, { dids: followedDids, fetchedAt: Date.now() });
      
      // Update global active followed DIDs for Jetstream indexing
      for (const did of followedDids) {
        activeFollowedDids.add(did);
      }
      console.log(`[Cache] Updated follows for ${requesterDid}. Count: ${followedDids.size}. Active DIDs: ${activeFollowedDids.size}`);
    }
  } catch (err) {
    console.error(`[Cache] Error fetching follows for ${requesterDid}:`, err);
    // If API fetch fails, return cached DB values if they exist
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

// Feed response cache (Proposal 4: Feed Output Caching)
interface CacheEntry {
  body: any;
  expiresAt: number;
}
const feedOutputCache = new Map<string, CacheEntry>();

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

// 3. Get Feed Skeleton (Personalized & Cached)
app.get('/xrpc/app.bsky.feed.getFeedSkeleton', async (req, res) => {
  const feedParam = req.query.feed as string;
  const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const cursorParam = req.query.cursor as string;

  if (feedParam !== feedUri) {
    return res.status(400).json({ error: 'Unsupported feed URI' });
  }

  try {
    const requesterDid = getRequesterDid(req);

    // Apply feed output caching (Proposal 4)
    const cacheKey = `${requesterDid || 'public'}:${limitParam}:${cursorParam || 'start'}`;
    const cached = feedOutputCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.body);
    }

    let followedDids = new Set<string>();
    if (requesterDid) {
      followedDids = await getFollowedDids(requesterDid);
    }

    const result = getPersonalizedFeed(
      requesterDid || 'public', 
      followedDids, 
      authorReputations,
      limitParam, 
      cursorParam
    );

    // Cache results for 60 seconds
    feedOutputCache.set(cacheKey, {
      body: result,
      expiresAt: Date.now() + 60 * 1000
    });

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
console.log('[Jetstream] Subscribing to Bluesky post/like stream...');
const jetstream = new Jetstream({
  wantedCollections: ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.repost'],
  endpoint: 'wss://jetstream1.us-east.bsky.network/subscribe'
});

// Helper to retrieve the text of a quoted post
async function getPostText(uri: string): Promise<string | null> {
  // 1. Try local DB first
  const localText = getPostTextLocal(uri);
  if (localText !== null) {
    return localText;
  }

  // 2. Try fetching from Bluesky API if logged in
  if (isAgentLoggedIn) {
    try {
      const response = await agent.app.bsky.feed.getPosts({ uris: [uri] });
      const post = response.data.posts[0];
      if (post && post.record) {
        return (post.record as any).text || '';
      }
    } catch {
      // Quietly ignore network failures for single lookups
    }
  }
  return null;
}

// Handle Posts (Queue them instead of direct writing - Proposal 3)
jetstream.onCreate('app.bsky.feed.post', async (event) => {
  const post = event.commit.record;
  const author = event.did;
  const uri = `at://${author}/${event.commit.collection}/${event.commit.rkey}`;
  const cid = event.commit.cid;

  // 1. Capture replies to our indexed posts to measure conversation engagement
  if (post.reply && post.reply.parent) {
    const parentUri = post.reply.parent.uri;
    if (indexedPostsCache.has(parentUri)) {
      try {
        queueReply(parentUri, author);
      } catch (err) {
        console.error('[Jetstream] Error logging reply count:', err);
      }
    }
  }

  // 2. Determine if this post itself should be indexed in our feed
  try {
    const { shouldInclude, isReply } = shouldIncludePost(post);
    if (!shouldInclude) return;

    // Quote post verification: Check if this is a quote post and verify the parent post
    let quotedUri: string | undefined;
    if (post.embed) {
      if (post.embed.$type === 'app.bsky.embed.record') {
        quotedUri = post.embed.record?.uri;
      } else if (post.embed.$type === 'app.bsky.embed.recordWithMedia') {
        quotedUri = post.embed.record?.record?.uri;
      }
    }

    if (quotedUri && quotedUri.includes('app.bsky.feed.post')) {
      const quotedText = await getPostText(quotedUri);
      // If we got the text and it contains negative terms, discard this quote post
      if (quotedText !== null && !isTextClean(quotedText)) {
        return;
      }
    }

    queuePost(uri, cid, author, post.text || '', isReply);
    trackIndexedPost(uri);
  } catch (err) {
    console.error('[Jetstream] Error processing post:', err);
  }
});

// Handle Likes (Queue global likes for posts we have indexed)
jetstream.onCreate('app.bsky.feed.like', (event) => {
  const like = event.commit.record;
  const likerDid = event.did;
  const postUri = like.subject?.uri;

  if (postUri && indexedPostsCache.has(postUri)) {
    try {
      queueLike(postUri, likerDid);
    } catch (err) {
      console.error('[Jetstream] Error processing like:', err);
    }
  }
});

// Handle Reposts (Queue global reposts for posts we have indexed)
jetstream.onCreate('app.bsky.feed.repost', (event) => {
  const repost = event.commit.record;
  const reposterDid = event.did;
  const postUri = repost.subject?.uri;

  if (postUri && indexedPostsCache.has(postUri)) {
    try {
      queueRepost(postUri, reposterDid);
    } catch (err) {
      console.error('[Jetstream] Error processing repost:', err);
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

// Flush queued database inserts every 1 second (Proposal 3)
setInterval(() => {
  try {
    flushQueue();
  } catch (err) {
    console.error('[DB] Error during flush queue:', err);
  }
}, 1000);

// Prune database hourly (keep posts/likes for 48 hours)
setInterval(() => {
  try {
    pruneOldPosts(48);
    // Clear expired feed cache entries to release memory
    const now = Date.now();
    for (const [key, cached] of feedOutputCache.entries()) {
      if (now > cached.expiresAt) {
        feedOutputCache.delete(key);
      }
    }
  } catch (err) {
    console.error('[Maintenance] Error during hourly tasks:', err);
  }
}, 60 * 60 * 1000);

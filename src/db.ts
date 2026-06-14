import DatabaseConstructor from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.FEEDGEN_SQLITE_LOCATION || './feed.db';
const db = new DatabaseConstructor(path.resolve(dbPath));

export interface Post {
  uri: string;
  cid: string;
  author: string;
  text: string;
  isReply: number;
  indexedAt: string;
}
export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      isReply INTEGER NOT NULL DEFAULT 0,
      isQuote INTEGER NOT NULL DEFAULT 0,
      indexedAt TEXT NOT NULL,
      likesCount INTEGER NOT NULL DEFAULT 0,
      repostsCount INTEGER NOT NULL DEFAULT 0,
      repliesCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
    CREATE INDEX IF NOT EXISTS idx_posts_indexedAt ON posts(indexedAt DESC);

    CREATE TABLE IF NOT EXISTS likes (
      postUri TEXT NOT NULL,
      likerDid TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
      PRIMARY KEY (postUri, likerDid)
    );
    CREATE INDEX IF NOT EXISTS idx_likes_likerDid ON likes(likerDid);

    CREATE TABLE IF NOT EXISTS reposts (
      postUri TEXT NOT NULL,
      reposterDid TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
      PRIMARY KEY (postUri, reposterDid)
    );
    CREATE INDEX IF NOT EXISTS idx_reposts_reposterDid ON reposts(reposterDid);

    CREATE TABLE IF NOT EXISTS replies (
      parentUri TEXT NOT NULL,
      replyAuthor TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
      PRIMARY KEY (parentUri, replyAuthor)
    );
    CREATE INDEX IF NOT EXISTS idx_replies_parentUri ON replies(parentUri);

    CREATE TABLE IF NOT EXISTS follows (
      userDid TEXT NOT NULL,
      followedDid TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (userDid, followedDid)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_userDid ON follows(userDid);
    CREATE INDEX IF NOT EXISTS idx_follows_followedDid ON follows(followedDid);
  `);

  // Run migrations for existing databases
  try {
    db.exec("ALTER TABLE posts ADD COLUMN likesCount INTEGER NOT NULL DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE posts ADD COLUMN repostsCount INTEGER NOT NULL DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE posts ADD COLUMN repliesCount INTEGER NOT NULL DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE posts ADD COLUMN isQuote INTEGER NOT NULL DEFAULT 0");
  } catch {}
}

// Queues for batch writing
interface QueuedPost {
  uri: string;
  cid: string;
  author: string;
  text: string;
  isReply: number;
  isQuote: number;
  indexedAt: string;
}

interface QueuedLike {
  postUri: string;
  likerDid: string;
  indexedAt: string;
}

interface QueuedRepost {
  postUri: string;
  reposterDid: string;
  indexedAt: string;
}

interface QueuedReply {
  parentUri: string;
  replyAuthor: string;
  indexedAt: string;
}

let queuedPosts: QueuedPost[] = [];
let queuedLikes: QueuedLike[] = [];
let queuedReposts: QueuedRepost[] = [];
let queuedReplies: QueuedReply[] = [];

export function queuePost(
  uri: string, 
  cid: string, 
  author: string, 
  text: string, 
  isReply: boolean = false,
  isQuote: boolean = false
) {
  queuedPosts.push({
    uri,
    cid,
    author,
    text,
    isReply: isReply ? 1 : 0,
    isQuote: isQuote ? 1 : 0,
    indexedAt: new Date().toISOString()
  });
}

export function queueLike(postUri: string, likerDid: string) {
  queuedLikes.push({
    postUri,
    likerDid,
    indexedAt: new Date().toISOString()
  });
}

export function queueRepost(postUri: string, reposterDid: string) {
  queuedReposts.push({
    postUri,
    reposterDid,
    indexedAt: new Date().toISOString()
  });
}

export function queueReply(parentUri: string, replyAuthor: string) {
  queuedReplies.push({
    parentUri,
    replyAuthor,
    indexedAt: new Date().toISOString()
  });
}

// Flush queue to database inside a single transaction (every 1 second)
export function flushQueue() {
  if (queuedPosts.length === 0 && queuedLikes.length === 0 && queuedReposts.length === 0 && queuedReplies.length === 0) return;

  const start = Date.now();
  
  const insertPostStmt = db.prepare(`
    INSERT INTO posts (uri, cid, author, text, isReply, isQuote, indexedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO NOTHING
  `);

  const insertLikeStmt = db.prepare(`
    INSERT INTO likes (postUri, likerDid, indexedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(postUri, likerDid) DO NOTHING
  `);

  const insertRepostStmt = db.prepare(`
    INSERT INTO reposts (postUri, reposterDid, indexedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(postUri, reposterDid) DO NOTHING
  `);

  const insertReplyStmt = db.prepare(`
    INSERT INTO replies (parentUri, replyAuthor, indexedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(parentUri, replyAuthor) DO NOTHING
  `);

  const updateLikeCountStmt = db.prepare('UPDATE posts SET likesCount = likesCount + 1 WHERE uri = ?');
  const updateRepostCountStmt = db.prepare('UPDATE posts SET repostsCount = repostsCount + 1 WHERE uri = ?');
  const updateReplyCountStmt = db.prepare('UPDATE posts SET repliesCount = repliesCount + 1 WHERE uri = ?');

  const transaction = db.transaction((
    posts: QueuedPost[], 
    likes: QueuedLike[], 
    reposts: QueuedRepost[],
    replies: QueuedReply[]
  ) => {
    for (const post of posts) {
      insertPostStmt.run(post.uri, post.cid, post.author, post.text, post.isReply, post.isQuote, post.indexedAt);
    }
    for (const like of likes) {
      insertLikeStmt.run(like.postUri, like.likerDid, like.indexedAt);
      updateLikeCountStmt.run(like.postUri);
    }
    for (const repost of reposts) {
      insertRepostStmt.run(repost.postUri, repost.reposterDid, repost.indexedAt);
      updateRepostCountStmt.run(repost.postUri);
    }
    for (const reply of replies) {
      insertReplyStmt.run(reply.parentUri, reply.replyAuthor, reply.indexedAt);
      updateReplyCountStmt.run(reply.parentUri);
    }
  });

  try {
    transaction(queuedPosts, queuedLikes, queuedReposts, queuedReplies);
    const countP = queuedPosts.length;
    const countL = queuedLikes.length;
    const countR = queuedReposts.length;
    const countRep = queuedReplies.length;
    queuedPosts = [];
    queuedLikes = [];
    queuedReposts = [];
    queuedReplies = [];
    if (countP > 0 || countL > 0 || countR > 0 || countRep > 0) {
      console.log(`[DB] Flushed ${countP} posts, ${countL} likes, ${countR} reposts, and ${countRep} replies in ${Date.now() - start}ms.`);
    }
  } catch (err) {
    console.error('[DB] Failed to flush queue transaction:', err);
  }
}

// Follows relation helper methods
export function saveFollows(userDid: string, followedDids: string[]) {
  const updatedAt = new Date().toISOString();
  
  const deleteStmt = db.prepare('DELETE FROM follows WHERE userDid = ?');
  const insertStmt = db.prepare(`
    INSERT INTO follows (userDid, followedDid, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(userDid, followedDid) DO NOTHING
  `);

  const transaction = db.transaction((user: string, dids: string[]) => {
    deleteStmt.run(user);
    for (const did of dids) {
      insertStmt.run(user, did, updatedAt);
    }
  });

  try {
    transaction(userDid, followedDids);
    console.log(`[DB] Saved ${followedDids.length} follows for user ${userDid}`);
  } catch (err) {
    console.error(`[DB] Failed to save follows for user ${userDid}:`, err);
  }
}

export function loadAllFollowedDids(): Set<string> {
  try {
    const rows = db.prepare('SELECT DISTINCT followedDid FROM follows').all() as { followedDid: string }[];
    const set = new Set(rows.map((r) => r.followedDid));
    console.log(`[DB] Loaded ${set.size} unique followed DIDs from DB into active set.`);
    return set;
  } catch (err) {
    console.error('[DB] Failed to load followed DIDs:', err);
    return new Set();
  }
}

export function loadRecentPostUris(limit: number = 50000): string[] {
  try {
    const rows = db.prepare('SELECT uri FROM posts ORDER BY indexedAt DESC LIMIT ?').all(limit) as { uri: string }[];
    return rows.map((r) => r.uri);
  } catch (err) {
    console.error('[DB] Failed to load recent post URIs:', err);
    return [];
  }
}

export function getCachedFollowedDids(userDid: string): Set<string> {
  try {
    const rows = db.prepare('SELECT followedDid FROM follows WHERE userDid = ?').all(userDid) as { followedDid: string }[];
    return new Set(rows.map((r) => r.followedDid));
  } catch (err) {
    console.error(`[DB] Failed to fetch follows for user ${userDid} from DB:`, err);
    return new Set();
  }
}

// Fallback public feed (no personalization, original posts only)
export function getFeed(limit: number = 50, cursor?: string): { feed: { post: string }[]; cursor?: string } {
  let stmt;
  let rows: Post[];

  if (cursor) {
    const timeStr = new Date(parseInt(cursor, 10)).toISOString();
    stmt = db.prepare(`
      SELECT uri, indexedAt FROM posts
      WHERE isReply = 0 AND indexedAt < ?
      ORDER BY indexedAt DESC, uri DESC
      LIMIT ?
    `);
    rows = stmt.all(timeStr, limit) as any[];
  } else {
    stmt = db.prepare(`
      SELECT uri, indexedAt FROM posts
      WHERE isReply = 0
      ORDER BY indexedAt DESC, uri DESC
      LIMIT ?
    `);
    rows = stmt.all(limit) as any[];
  }

  const feed = rows.map((row) => ({ post: row.uri }));
  let nextCursor: string | undefined;
  
  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    nextCursor = new Date(lastRow.indexedAt).getTime().toString();
  }

  return { feed, cursor: nextCursor };
}

// Personalized feed ranking (Time decay + Follows Boost + Likes Boost + Reposts Boost + Content Alignment)
export function getPersonalizedFeed(
  userDid: string,
  followedDidsSet: Set<string>,
  authorReputations: Map<string, { avgEngagement: number; postCount: number }>,
  limit: number = 50,
  cursor?: string
): { feed: { post: string }[]; cursor?: string } {
  const now = Date.now();
  const cutoff = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago

  // 1. Fetch user's personalized topic profile (Content-Based recommender signal)
  const interestProfile = getUserInterestProfile(userDid);

  // 2. Fetch all candidate posts from the last 48 hours with their engagement stats
  const stmt = db.prepare(`
    SELECT 
      p.uri, 
      p.cid, 
      p.author, 
      p.text, 
      p.isReply, 
      p.isQuote,
      p.indexedAt,
      p.likesCount as globalLikesCount,
      p.repostsCount as globalRepostsCount,
      p.repliesCount as globalRepliesCount,
      (SELECT COUNT(*) FROM likes l JOIN follows f ON l.likerDid = f.followedDid WHERE f.userDid = ? AND l.postUri = p.uri) as followedLikesCount,
      (SELECT COUNT(*) FROM reposts r JOIN follows f ON r.reposterDid = f.followedDid WHERE f.userDid = ? AND r.postUri = p.uri) as followedRepostsCount,
      (SELECT COUNT(*) FROM replies rp JOIN follows f ON rp.replyAuthor = f.followedDid WHERE f.userDid = ? AND rp.parentUri = p.uri) as followedRepliesCount,
      (SELECT 1 FROM follows WHERE userDid = ? AND followedDid = p.author) as isFromFollowed
    FROM posts p
    WHERE p.indexedAt > ?
    ORDER BY p.indexedAt DESC
    LIMIT 2000
  `);

  const candidates = stmt.all(userDid, userDid, userDid, userDid, cutoff) as any[];

  // 3. Score candidates
  const scoredCandidates = candidates.map((post) => {
    const ageMs = now - new Date(post.indexedAt).getTime();
    const ageHours = Math.max(0.01, ageMs / (1000 * 60 * 60));

    // Time decay formula (Hacker News style)
    const gravity = 1.8;

    const globalLikes = post.globalLikesCount || 0;
    const globalReposts = post.globalRepostsCount || 0;
    const globalReplies = post.globalRepliesCount || 0;

    const followedLikes = post.followedLikesCount || 0;
    const followedReposts = post.followedRepostsCount || 0;
    const followedReplies = post.followedRepliesCount || 0;

    // Apply X-style weights: Repost: 20x, Reply: 27x, Like: 1x
    // Network boost adds heavier multipliers for immediate friends' activity
    const globalEngagement = (globalLikes * 1) + (globalReposts * 20) + (globalReplies * 27);
    const networkEngagement = (followedLikes * 5) + (followedReposts * 40) + (followedReplies * 54);
    const totalEngagement = globalEngagement + networkEngagement;

    let score = (totalEngagement + 1) / Math.pow(ageHours + 2, gravity);

    // Boost network content
    const isFromNetwork = post.author === userDid || post.isFromFollowed === 1;
    if (isFromNetwork) {
      if (post.isReply === 1) {
        score *= 3.0; // Reply from follow
      } else {
        score *= 8.0; // Post from follow
      }
    } else {
      // Out-of-network reply penalty: make it even stronger so random out-of-context replies to strangers don't show up.
      // Instead, we show root posts with arguments (which gets boosted below).
      if (post.isReply === 1) {
        score *= 0.02;
      }

      // Out-of-network content penalty if it has zero engagement
      // This prevents random unliked/unreposted posts from cluttering the feed
      if (totalEngagement === 0) {
        score *= 0.01;
      }
    }

    // Apply Controversy / Spicy Debate Boost (The Ratio)
    // If a post is a thread root (isReply === 0) and has generated replies, boost it based on debate metrics.
    if (post.isReply === 0 && globalReplies > 0) {
      const debateRatio = globalReplies / Math.max(1, globalLikes);
      
      // Base discussion boost: more replies = more active debate
      let debateBoost = 1.0 + Math.min(2.5, globalReplies * 0.15);
      
      // Controversy boost ("The Ratio"): if replies outnumber likes, it's a heated argument
      if (debateRatio > 1.0 && globalReplies >= 3) {
        debateBoost *= (1.0 + Math.min(1.5, debateRatio * 0.3));
      }
      
      score *= debateBoost;
    }

    // Quote posts are highly engaging vehicles for hot takes and commentary
    if (post.isQuote === 1) {
      score *= 1.8;
    }

    // Apply Creator Reputation multipliers (crawled in background)
    const reputation = authorReputations.get(post.author);
    if (reputation) {
      // Spammer penalty: if posting more than 15 times a day, scale down
      if (reputation.postCount > 15) {
        const spamPenalty = Math.max(0.2, 1.0 - (reputation.postCount - 15) * 0.05);
        score *= spamPenalty;
      }
      // Creator boost: if their posts average > 2 engagement units, boost
      if (reputation.avgEngagement > 2.0) {
        const creatorBoost = 1.0 + Math.min(2.0, reputation.avgEngagement * 0.15);
        score *= creatorBoost;
      }
    }

    // Apply User Interest Profile Alignment (Cosine similarity/keyword overlap)
    const profileRelevance = calculateProfileRelevance(post.text, interestProfile);
    score *= profileRelevance;

    return { uri: post.uri, score };
  });

  // 4. Sort by final score
  scoredCandidates.sort((a, b) => b.score - a.score);

  // 5. Index-based pagination
  let startIndex = 0;
  if (cursor) {
    const parsedCursor = parseInt(cursor, 10);
    if (!isNaN(parsedCursor)) {
      startIndex = parsedCursor;
    }
  }

  const sliced = scoredCandidates.slice(startIndex, startIndex + limit);
  const feed = sliced.map((c) => ({ post: c.uri }));

  let nextCursor: string | undefined;
  if (startIndex + limit < scoredCandidates.length) {
    nextCursor = (startIndex + limit).toString();
  }

  return { feed, cursor: nextCursor };
}

export function pruneOldPosts(maxAgeHours: number = 48) {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
  
  // Prune posts
  const postsStmt = db.prepare(`DELETE FROM posts WHERE indexedAt < ?`);
  const postsRes = postsStmt.run(cutoff);
  
  // Prune likes
  const likesStmt = db.prepare(`DELETE FROM likes WHERE indexedAt < ?`);
  const likesRes = likesStmt.run(cutoff);

  // Prune reposts
  const repostsStmt = db.prepare(`DELETE FROM reposts WHERE indexedAt < ?`);
  const repostsRes = repostsStmt.run(cutoff);

  // Prune replies
  const repliesStmt = db.prepare(`DELETE FROM replies WHERE indexedAt < ?`);
  const repliesRes = repliesStmt.run(cutoff);

  console.log(`[DB] Pruned ${postsRes.changes} posts, ${likesRes.changes} likes, ${repostsRes.changes} reposts, and ${repliesRes.changes} replies older than ${maxAgeHours} hours.`);
}

export function getPostTextLocal(uri: string): string | null {
  try {
    const row = db.prepare('SELECT text FROM posts WHERE uri = ?').get(uri) as { text: string } | undefined;
    return row ? row.text : null;
  } catch {
    return null;
  }
}

// Stop words for TF-IDF / Content-based profiling
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'arent', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'cant', 'cannot', 'could',
  'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell', 'hes', 'her', 'here', 'heres',
  'hers', 'herself', 'him', 'himself', 'his', 'how', 'hows', 'i', 'id', 'ill', 'im', 'ive', 'if', 'in', 'into',
  'is', 'isnt', 'it', 'its', 'itself', 'lets', 'me', 'more', 'most', 'mustnt', 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'shant', 'she', 'shed', 'shell', 'shes', 'should', 'shouldnt', 'so', 'some', 'such', 'than', 'that',
  'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'theres', 'these', 'they', 'theyd',
  'theyll', 'theyre', 'theyve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'wasnt', 'we', 'wed', 'well', 'were', 'weve', 'werent', 'what', 'whats', 'when', 'whens', 'where', 'wheres',
  'which', 'while', 'who', 'whos', 'whom', 'why', 'whys', 'with', 'wont', 'would', 'wouldnt', 'you', 'youd',
  'youll', 'youre', 'youve', 'your', 'yours', 'yourself', 'yourselves', 'the', 'and', 'but', 'for', 'our', 'you'
]);

function extractKeywords(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s#@]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

export function getUserInteractedPostTexts(userDid: string, limit: number = 100): string[] {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT p.text FROM posts p
      JOIN likes l ON p.uri = l.postUri
      WHERE l.likerDid = ?
      UNION
      SELECT DISTINCT p.text FROM posts p
      JOIN reposts r ON p.uri = r.postUri
      WHERE r.reposterDid = ?
      LIMIT ?
    `).all(userDid, userDid, limit) as { text: string }[];
    return rows.map((r) => r.text);
  } catch (err) {
    console.error('[DB] Failed to fetch user interacted post texts:', err);
    return [];
  }
}

export function getUserInterestProfile(userDid: string): Map<string, number> {
  const profile = new Map<string, number>();
  if (!userDid || userDid === 'public') return profile;
  
  const texts = getUserInteractedPostTexts(userDid, 100);
  for (const text of texts) {
    const keywords = extractKeywords(text);
    for (const kw of keywords) {
      profile.set(kw, (profile.get(kw) || 0) + 1);
    }
  }
  return profile;
}

function calculateProfileRelevance(postText: string, profile: Map<string, number>): number {
  if (profile.size === 0) return 1.0;
  
  const keywords = extractKeywords(postText);
  if (keywords.length === 0) return 1.0;
  
  let score = 0;
  for (const kw of keywords) {
    if (profile.has(kw)) {
      score += profile.get(kw)!;
    }
  }
  
  const multiplier = 1.0 + Math.log1p(score) * 0.4;
  return Math.min(3.0, multiplier);
}

export function getAuthorReputations(cutoff: string): Map<string, { avgEngagement: number; postCount: number }> {
  const reputations = new Map<string, { avgEngagement: number; postCount: number }>();
  try {
    const rows = db.prepare(`
      SELECT 
        p.author, 
        COUNT(p.uri) as postCount,
        COALESCE(SUM(
          p.likesCount * 1 + 
          p.repostsCount * 3 +
          p.repliesCount * 5
        ), 0) as totalEngagement
      FROM posts p
      WHERE p.indexedAt > ?
      GROUP BY p.author
    `).all(cutoff) as { author: string; postCount: number; totalEngagement: number }[];

    for (const r of rows) {
      reputations.set(r.author, {
        avgEngagement: r.totalEngagement / Math.max(1, r.postCount),
        postCount: r.postCount
      });
    }
  } catch (err) {
    console.error('[DB] Failed to calculate author reputations:', err);
  }
  return reputations;
}

export function getRecentPostUrisForSync(limit: number = 500): string[] {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare('SELECT uri FROM posts WHERE indexedAt > ? ORDER BY indexedAt DESC LIMIT ?').all(cutoff) as { uri: string }[];
    return rows.map((r) => r.uri);
  } catch {
    return [];
  }
}

export function updatePostEngagementCounts(uri: string, likes: number, reposts: number, replies: number) {
  try {
    db.prepare('UPDATE posts SET likesCount = ?, repostsCount = ?, repliesCount = ? WHERE uri = ?')
      .run(likes, reposts, replies, uri);
  } catch (err) {
    console.error('[DB] Failed to update post engagement counts:', err);
  }
}

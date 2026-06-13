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
      indexedAt TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS follows (
      userDid TEXT NOT NULL,
      followedDid TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (userDid, followedDid)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_userDid ON follows(userDid);
    CREATE INDEX IF NOT EXISTS idx_follows_followedDid ON follows(followedDid);
  `);
}

// Queues for batch writing
interface QueuedPost {
  uri: string;
  cid: string;
  author: string;
  text: string;
  isReply: number;
  indexedAt: string;
}

interface QueuedLike {
  postUri: string;
  likerDid: string;
  indexedAt: string;
}

let queuedPosts: QueuedPost[] = [];
let queuedLikes: QueuedLike[] = [];

export function queuePost(uri: string, cid: string, author: string, text: string, isReply: boolean = false) {
  queuedPosts.push({
    uri,
    cid,
    author,
    text,
    isReply: isReply ? 1 : 0,
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

// Flush queue to database inside a single transaction (every 1 second)
export function flushQueue() {
  if (queuedPosts.length === 0 && queuedLikes.length === 0) return;

  const start = Date.now();
  
  const insertPostStmt = db.prepare(`
    INSERT INTO posts (uri, cid, author, text, isReply, indexedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO NOTHING
  `);

  const insertLikeStmt = db.prepare(`
    INSERT INTO likes (postUri, likerDid, indexedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(postUri, likerDid) DO NOTHING
  `);

  const transaction = db.transaction((posts: QueuedPost[], likes: QueuedLike[]) => {
    for (const post of posts) {
      insertPostStmt.run(post.uri, post.cid, post.author, post.text, post.isReply, post.indexedAt);
    }
    for (const like of likes) {
      insertLikeStmt.run(like.postUri, like.likerDid, like.indexedAt);
    }
  });

  try {
    transaction(queuedPosts, queuedLikes);
    const countP = queuedPosts.length;
    const countL = queuedLikes.length;
    queuedPosts = [];
    queuedLikes = [];
    if (countP > 0 || countL > 0) {
      console.log(`[DB] Flushed ${countP} posts and ${countL} likes in ${Date.now() - start}ms.`);
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

// Personalized feed ranking (Time decay + Follows Boost + Likes Boost)
export function getPersonalizedFeed(
  userDid: string,
  followedDidsSet: Set<string>,
  limit: number = 50,
  cursor?: string
): { feed: { post: string }[]; cursor?: string } {
  // If the user doesn't follow anyone, return the general public feed
  if (followedDidsSet.size === 0) {
    return getFeed(limit, cursor);
  }

  const now = Date.now();

  // Fetch posts from followed users via SQL JOIN
  const followedPostsStmt = db.prepare(`
    SELECT p.* FROM posts p
    JOIN follows f ON p.author = f.followedDid
    WHERE f.userDid = ?
    ORDER BY p.indexedAt DESC
    LIMIT 1000
  `);
  const followedPosts = followedPostsStmt.all(userDid) as any[];

  // Fetch posts liked by followed users via SQL JOIN
  const likedPostsStmt = db.prepare(`
    SELECT p.*, COUNT(l.likerDid) as followedLikesCount
    FROM posts p
    JOIN likes l ON p.uri = l.postUri
    JOIN follows f ON l.likerDid = f.followedDid
    WHERE f.userDid = ?
    GROUP BY p.uri
    ORDER BY p.indexedAt DESC
    LIMIT 1000
  `);
  const likedPosts = likedPostsStmt.all(userDid) as any[];

  // Fetch recent general posts
  const generalPostsStmt = db.prepare(`
    SELECT * FROM posts
    WHERE isReply = 0
    ORDER BY indexedAt DESC
    LIMIT 1000
  `);
  const generalPosts = generalPostsStmt.all() as any[];

  // Combine and score candidates
  const candidatesMap = new Map<string, { post: any; score: number }>();

  const addCandidate = (post: any, followedLikesCount: number = 0) => {
    if (candidatesMap.has(post.uri)) {
      if (followedLikesCount > 0) {
        const existing = candidatesMap.get(post.uri)!;
        existing.post.followedLikesCount = Math.max(existing.post.followedLikesCount || 0, followedLikesCount);
      }
      return;
    }

    // Filter out replies from people NOT followed
    if (post.isReply === 1 && !followedDidsSet.has(post.author)) {
      return;
    }

    candidatesMap.set(post.uri, { post, score: 0 });
  };

  for (const p of followedPosts) {
    addCandidate(p);
  }
  for (const p of likedPosts) {
    addCandidate(p, p.followedLikesCount);
  }
  for (const p of generalPosts) {
    addCandidate(p);
  }

  const candidates = Array.from(candidatesMap.values());
  for (const c of candidates) {
    const post = c.post;
    const ageMs = now - new Date(post.indexedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    // Gravity time decay formula
    let baseScore = 100 / Math.pow(ageHours + 2, 1.8);

    // Personalization boosts
    let boost = 1.0;

    // Boost if authored by followed user
    if (followedDidsSet.has(post.author)) {
      if (post.isReply === 1) {
        boost *= 4.0;
      } else {
        boost *= 8.0;
      }
    }

    // Boost based on followed users' likes
    const likesCount = post.followedLikesCount || 0;
    if (likesCount > 0) {
      boost *= (1.0 + likesCount * 3.0);
    }

    c.score = baseScore * boost;
  }

  // Sort by final recommendation score
  candidates.sort((a, b) => b.score - a.score);

  // Index-based pagination
  let startIndex = 0;
  if (cursor) {
    const parsedCursor = parseInt(cursor, 10);
    if (!isNaN(parsedCursor)) {
      startIndex = parsedCursor;
    }
  }

  const sliced = candidates.slice(startIndex, startIndex + limit);
  const feed = sliced.map((c) => ({ post: c.post.uri }));

  let nextCursor: string | undefined;
  if (startIndex + limit < candidates.length) {
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

  console.log(`[DB] Pruned ${postsRes.changes} posts and ${likesRes.changes} likes older than ${maxAgeHours} hours.`);
}

export function getPostTextLocal(uri: string): string | null {
  try {
    const row = db.prepare('SELECT text FROM posts WHERE uri = ?').get(uri) as { text: string } | undefined;
    return row ? row.text : null;
  } catch {
    return null;
  }
}

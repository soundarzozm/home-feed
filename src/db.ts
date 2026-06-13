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
  `);
}

export function savePost(uri: string, cid: string, author: string, text: string, isReply: boolean = false) {
  const indexedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO posts (uri, cid, author, text, isReply, indexedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO NOTHING
  `);
  stmt.run(uri, cid, author, text, isReply ? 1 : 0, indexedAt);
}

export function saveLike(postUri: string, likerDid: string) {
  const indexedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO likes (postUri, likerDid, indexedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(postUri, likerDid) DO NOTHING
  `);
  stmt.run(postUri, likerDid, indexedAt);
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
  followedDidsSet: Set<string>,
  limit: number = 50,
  cursor?: string
): { feed: { post: string }[]; cursor?: string } {
  // If the user doesn't follow anyone, return the general public feed
  if (followedDidsSet.size === 0) {
    return getFeed(limit, cursor);
  }

  const followedDids = Array.from(followedDidsSet);
  const now = Date.now();
  const placeholders = followedDids.map(() => '?').join(',');

  // Fetch posts from followed users (max 1000)
  const followedPostsStmt = db.prepare(`
    SELECT * FROM posts 
    WHERE author IN (${placeholders})
    ORDER BY indexedAt DESC
    LIMIT 1000
  `);
  const followedPosts = followedPostsStmt.all(...followedDids) as any[];

  // Fetch posts liked by followed users (max 1000)
  const likedPostsStmt = db.prepare(`
    SELECT p.*, COUNT(l.likerDid) as followedLikesCount
    FROM posts p
    JOIN likes l ON p.uri = l.postUri
    WHERE l.likerDid IN (${placeholders})
    GROUP BY p.uri
    ORDER BY p.indexedAt DESC
    LIMIT 1000
  `);
  const likedPosts = likedPostsStmt.all(...followedDids) as any[];

  // Fetch recent general posts (max 1000)
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
        boost *= 4.0; // Followed user's replies get a solid boost
      } else {
        boost *= 8.0; // Followed user's original posts get a huge boost
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

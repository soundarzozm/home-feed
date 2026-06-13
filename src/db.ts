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
  indexedAt: string;
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_indexedAt ON posts(indexedAt DESC);
  `);
}

export function savePost(uri: string, cid: string, author: string, text: string) {
  const indexedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO posts (uri, cid, author, text, indexedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO NOTHING
  `);
  stmt.run(uri, cid, author, text, indexedAt);
}

export function getFeed(limit: number = 50, cursor?: string): { feed: { post: string }[]; cursor?: string } {
  let stmt;
  let rows: Post[];

  if (cursor) {
    const timeStr = new Date(parseInt(cursor, 10)).toISOString();
    stmt = db.prepare(`
      SELECT uri, indexedAt FROM posts
      WHERE indexedAt < ?
      ORDER BY indexedAt DESC, uri DESC
      LIMIT ?
    `);
    rows = stmt.all(timeStr, limit) as any[];
  } else {
    stmt = db.prepare(`
      SELECT uri, indexedAt FROM posts
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

export function pruneOldPosts(maxAgeHours: number = 48) {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`DELETE FROM posts WHERE indexedAt < ?`);
  const result = stmt.run(cutoff);
  console.log(`[DB] Pruned ${result.changes} posts older than ${maxAgeHours} hours.`);
}

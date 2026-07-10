import { defineTool } from "eve/tools";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Markdown remains the source of truth. SQLite is only a local, rebuildable FTS5
// sidecar: no network service, embeddings or data export are required for recall.
const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";
const SEARCH_DIRS = ["cards", "summaries", "weekly", "monthly", "yearly"];
const IGNORE = new Set([".git", ".graph", ".index", ".trash", "attachments", "node_modules"]);
const MAX_BODY = 24_000;

type Document = { path: string; mtimeMs: number; size: number; title: string; body: string };
type Hit = { file: string; score: number; snippet: string };

function walk(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

function titleOf(text: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || fallback.replace(/\.md$/, "").split("/").pop() || fallback;
}

function readDocuments(scope: string[]): Document[] {
  const vault = VAULT();
  const files: string[] = [];
  for (const dir of scope) walk(join(vault, dir), files);
  return files.flatMap((file) => {
    try {
      const stat = statSync(file);
      const raw = readFileSync(file, "utf8");
      const path = relative(vault, file).split(sep).join("/");
      return [{ path, mtimeMs: stat.mtimeMs, size: stat.size, title: titleOf(raw, path), body: raw.slice(0, MAX_BODY) }];
    } catch {
      return [];
    }
  });
}

function indexPath(): string {
  const dir = join(VAULT(), ".index");
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.sqlite");
}

function syncIndex(db: DatabaseSync, docs: Document[]): number {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS memory_meta (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      path UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2'
    );
  `);
  const known = new Map(
    (db.prepare("SELECT path, mtime_ms, size FROM memory_meta").all() as Array<{ path: string; mtime_ms: number; size: number }>).map(
      (row) => [row.path, row],
    ),
  );
  const delMeta = db.prepare("DELETE FROM memory_meta WHERE path = ?");
  const delFts = db.prepare("DELETE FROM memory_fts WHERE path = ?");
  const addMeta = db.prepare("INSERT INTO memory_meta(path, mtime_ms, size) VALUES (?, ?, ?)");
  const addFts = db.prepare("INSERT INTO memory_fts(path, title, body) VALUES (?, ?, ?)");
  const seen = new Set(docs.map((doc) => doc.path));
  let changed = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const doc of docs) {
      const old = known.get(doc.path);
      if (old && old.mtime_ms === doc.mtimeMs && old.size === doc.size) continue;
      delFts.run(doc.path);
      delMeta.run(doc.path);
      addMeta.run(doc.path, doc.mtimeMs, doc.size);
      addFts.run(doc.path, doc.title, doc.body);
      changed += 1;
    }
    for (const path of known.keys()) {
      if (seen.has(path)) continue;
      delFts.run(path);
      delMeta.run(path);
      changed += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return changed;
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
}

function ftsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replaceAll('"', "")}"*`).join(" OR ");
}

function snippet(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  const pos = tokens.map((token) => lower.indexOf(token)).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
  return text.slice(Math.max(0, pos - 80), pos + 220).replace(/\s+/g, " ").trim();
}

function naiveSearch(docs: Document[], tokens: string[], limit: number): Hit[] {
  return docs
    .map((doc) => {
      const haystack = `${doc.title}\n${doc.body}`.toLowerCase();
      const matches = tokens.reduce((total, token) => total + (haystack.match(new RegExp(token, "gu"))?.length || 0), 0);
      return { file: doc.path, score: matches, snippet: snippet(doc.body, tokens) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export default defineTool({
  description:
    "Ранжированный поиск по долговременной памяти: постоянный локальный SQLite FTS5-индекс поверх Markdown vault. " +
    "Используй первым для вопросов «что я знаю про X», затем открой 1–3 лучших файла через read_file.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Запрос: имена, тема, решение или факт"),
    limit: z.number().int().min(1).max(20).optional().describe("Число результатов, по умолчанию 8"),
    scope: z.array(z.string()).optional().describe("Поддиректории vault; по умолчанию cards и summaries"),
  }),
  async execute({ query, limit, scope }) {
    const tokens = queryTokens(query);
    const max = limit ?? 8;
    const docs = readDocuments(scope?.length ? scope : SEARCH_DIRS);
    if (!docs.length || !tokens.length) return { count: 0, engine: "fts5", hits: [], note: "vault пуст или недоступен" };

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(indexPath());
      const updated = syncIndex(db, docs);
      const rows = db
        .prepare("SELECT path, body, -bm25(memory_fts, 5.0, 1.0) AS score FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts, 5.0, 1.0) LIMIT ?")
        .all(ftsQuery(tokens), max) as Array<{ path: string; body: string; score: number }>;
      return {
        count: rows.length,
        engine: "sqlite-fts5",
        indexed: updated,
        hits: rows.map((row) => ({ file: row.path, score: Number(row.score.toFixed(4)), snippet: snippet(row.body, tokens) })),
      };
    } catch (error) {
      const hits = naiveSearch(docs, tokens, max);
      return {
        count: hits.length,
        engine: "naive-fallback",
        hits,
        note: `SQLite FTS5 temporarily unavailable; used local fallback (${String(error).slice(0, 120)})`,
      };
    } finally {
      db?.close();
    }
  },
});

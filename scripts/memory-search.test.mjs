import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: memorySearch } = await import("../agent/tools/memory_search.ts");

test("memory search maintains a rebuildable SQLite FTS5 sidecar over Markdown", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-memory-search-"));
  const before = process.env.ASSISTANT_VAULT_DIR;
  try {
    await mkdir(join(vault, "cards", "projects"), { recursive: true });
    await mkdir(join(vault, "summaries", "daily"), { recursive: true });
    await writeFile(join(vault, "cards", "projects", "iva.md"), "# Iva\n\nPostgreSQL is the durable workflow runtime.\n");
    await writeFile(join(vault, "summaries", "daily", "2026-07-10.md"), "# Daily\n\nSQLite FTS5 indexes the Markdown vault for recall.\n");
    process.env.ASSISTANT_VAULT_DIR = vault;

    const first = await memorySearch.execute({ query: "PostgreSQL workflow" });
    const second = await memorySearch.execute({ query: "SQLite vault" });

    assert.equal(first.engine, "sqlite-fts5");
    assert.equal(first.hits[0]?.file, "cards/projects/iva.md");
    assert.equal(second.engine, "sqlite-fts5");
    assert.equal(second.hits[0]?.file, "summaries/daily/2026-07-10.md");
  } finally {
    if (before === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = before;
    await rm(vault, { recursive: true, force: true });
  }
});

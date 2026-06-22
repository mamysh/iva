#!/usr/bin/env node
// Merge upstream/main into the product branch and run the local safety checks.
// Conflicts are intentionally left to Git/Codex: resolve them, then rerun checks.
import { spawnSync } from "node:child_process";

const BRANCH = process.env.IVA_PROD_BRANCH || "codex/iva-prod";
const UPSTREAM = process.env.IVA_UPSTREAM_REF || "upstream/main";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", b: "\x1b[1m", x: "\x1b[0m" };
const step = (m) => console.log(`\n${C.b}${C.c}==> ${m}${C.x}`);
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const fail = (m) => {
  console.error(`${C.r}✗${C.x} ${m}`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
}

function cap(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
  return (res.stdout || "").trim();
}

function statusPorcelain() {
  return cap("git", ["status", "--porcelain"]);
}

function ensureClean() {
  const status = statusPorcelain();
  if (status) {
    console.log(status);
    fail("working tree is not clean; commit/stash/finish the current merge first");
  }
}

function hasChangedSinceOrigHead(paths) {
  const orig = cap("git", ["rev-parse", "--verify", "-q", "ORIG_HEAD"]);
  if (!orig) return true;
  const changed = cap("git", ["diff", "--name-only", `${orig}..HEAD`]).split("\n").filter(Boolean);
  return changed.some((p) => paths.includes(p));
}

step(`Switch to ${BRANCH}`);
ensureClean();
run("git", ["switch", BRANCH]);

step("Fetch origin/upstream");
run("git", ["fetch", "--all", "--tags", "--prune"]);

step(`Merge ${UPSTREAM}`);
const before = cap("git", ["rev-parse", "--short", "HEAD"]);
const merge = spawnSync("git", ["merge", "--no-ff", UPSTREAM], { stdio: "inherit" });
if (merge.status !== 0) {
  warn("merge stopped on conflicts");
  console.log(`
Resolve conflicts, keeping Iva product behavior where it differs intentionally:
- vault stays outside the app repo (ASSISTANT_VAULT_DIR)
- Telegram polling/MCP and Deepgram/vision fallback stay enabled
- product branch remains ${BRANCH}

Then run:
  git add <resolved-files>
  npm run typecheck
  npm run build
  git commit
`);
  process.exit(1);
}
const after = cap("git", ["rev-parse", "--short", "HEAD"]);
ok(`${before} -> ${after}`);

if (hasChangedSinceOrigHead(["package.json", "package-lock.json"])) {
  step("Install dependencies");
  run("npm", ["ci"]);
}

step("Typecheck");
run("npm", ["run", "typecheck"]);

step("Build");
run("npm", ["run", "build"]);

ok(`upstream synced into ${BRANCH}`);
console.log(`
Next:
  git push

Prod deploy checklist:
  1. Back up /home/iva/vault (commit + push).
  2. Pull ${BRANCH} in /home/iva/iva as user iva.
  3. npm ci if package files changed, then npm run build.
  4. Restart user services: iva, iva-telegram-poll, iva-telegram-mcp.
`);

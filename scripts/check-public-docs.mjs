import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md", "*.html"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const read = (path) => readFileSync(path, "utf8");
const packageVersion = JSON.parse(read("package.json")).version;
const ownerDocs = [
  "install", "configuration", "memory", "security", "providers", "deploy", "data-and-backup",
  "observability", "userbot", "cli", "owner-runbook", "supported", "faq", "troubleshooting",
];

for (const path of ["docs/index.html", "docs/ru/index.html"]) {
  assert.match(read(path), new RegExp(`"softwareVersion": "${packageVersion.replaceAll(".", "\\.")}"`));
}
assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${packageVersion.replaceAll(".", "\\.")}\\]`, "m"));

for (const path of ["README.md", "README.ru.md"]) {
  const text = read(path);
  assert.match(text, /Rich Messages|Rich replies|Богатые ответы/);
  assert.match(text, /userbot \(beta\)/i);
  assert.match(text, /`\/update`/);
  assert.match(text, /v0\.3\.0-rc\.4\/install\.sh/);
  assert.match(text, /BRANCH=v0\.3\.0-rc\.4/);
}
for (const name of ownerDocs) {
  assert.equal(existsSync(`docs/${name}.md`), true, `missing English owner doc: ${name}.md`);
  assert.equal(existsSync(`docs/ru/${name}.md`), true, `missing Russian owner doc: ${name}.md`);
}
for (const path of ["SECURITY.md", "SECURITY.ru.md", "CONTRIBUTING.md", "CONTRIBUTING.ru.md"]) {
  assert.equal(existsSync(path), true, `missing public project file: ${path}`);
}
assert.doesNotMatch(read("README.md"), /no extra bill/i);
assert.doesNotMatch(read("README.ru.md"), /ни лишнего сч[её]та/i);
assert.match(read("docs/deploy.md"), /two systemd user services and seven timers/i);
assert.match(read("docs/deploy.md"), /iva workflow-postgres enable/);
assert.match(read("docs/userbot.md"), /49 upstream read-only tools/);
assert.match(read("docs/userbot.md"), /four local onboarding tools/);
assert.match(read("docs/supported.md"), /Node\.js 24\.x/);
assert.match(read("docs/supported.md"), /Telegram userbot remains opt-in beta/i);
assert.match(read("docs/owner-runbook.md"), /iva backup <private-directory>/);
assert.match(read("docs/releasing.md"), /seven continuous days/i);

const publicText = [
  "README.md",
  "README.ru.md",
  "CHANGELOG.md",
  ".env.example",
  ...tracked.filter((path) => path.startsWith("docs/")),
].map(read).join("\n");
assert.doesNotMatch(publicText, /\/home\/iva\/iva|eve-assistant-\d|104\.248\.20\.98/);
assert.doesNotMatch(publicText, /TELEGRAM_ALLOWED_USER_IDS=\d{5,}/);
assert.doesNotMatch(publicText, /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/);

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
const anchors = new Map();
for (const path of tracked.filter((item) => item.endsWith(".md"))) {
  const values = new Set();
  for (const line of read(path).split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (match) values.add(slug(match[1]));
  }
  anchors.set(resolve(path), values);
}

for (const path of tracked) {
  const text = read(path);
  const urls = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim().replace(/^<|>$/g, ""));
  if (path.endsWith(".html")) {
    urls.push(...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]));
  }
  for (let url of urls) {
    let target;
    let fragment = "";
    if (url.startsWith("https://github.com/mamysh/iva/blob/main/")) {
      url = url.slice("https://github.com/mamysh/iva/blob/main/".length);
      [url, fragment = ""] = url.split("#");
      target = resolve(decodeURIComponent(url));
    } else if (url.startsWith("https://github.com/mamysh/iva#")) {
      target = resolve("README.md");
      fragment = url.split("#")[1] || "";
    } else if (!/^(?:https?:|mailto:|tg:|data:|#)/.test(url)) {
      [url, fragment = ""] = url.split("#");
      target = resolve(dirname(path), decodeURIComponent(url));
    } else {
      continue;
    }
    assert.ok(existsSync(target), `${path}: missing local link target ${url}`);
    if (fragment && target.endsWith(".md")) {
      assert.ok(anchors.get(target)?.has(decodeURIComponent(fragment).toLowerCase()), `${path}: missing anchor #${fragment}`);
    }
  }
}

console.log("public documentation checks passed");

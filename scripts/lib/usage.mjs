// Token usage accounting: one JSONL record per model step in data/usage.jsonl.
// Shared by the agent hook (write), Telegram /usage, and CLI `iva usage` (read).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const defaultDir = () => process.env.ASSISTANT_DATA_DIR || "data";

export function usageFilePath(dataDir = defaultDir()) {
  return join(dataDir, "usage.jsonl");
}

export function appendUsage(record, dataDir = defaultDir()) {
  const file = usageFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

export function readEntries(dataDir = defaultDir()) {
  let raw;
  try {
    raw = readFileSync(usageFilePath(dataDir), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // Tolerate a partial line after a crash during append.
    }
  }
  return out;
}

export function parseWindow(arg) {
  const a = (arg || "").trim().toLowerCase().replace(/^by[ -]/, "by-");
  const ok = ["last", "today", "week", "month", "by-model", "by-source"];
  return ok.includes(a) ? a : "last";
}

function localDate(ts, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function inWindow(e, window, now, tz) {
  const t = Date.parse(e.ts);
  if (Number.isNaN(t)) return false;
  if (window === "today") return localDate(e.ts, tz) === localDate(now, tz);
  if (window === "month") return localDate(e.ts, tz).slice(0, 7) === localDate(now, tz).slice(0, 7);
  if (window === "week") return t >= now - 7 * 86400000;
  return true;
}

const blank = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0, steps: 0, turns: new Set() });

function add(acc, e) {
  acc.in += e.in || 0;
  acc.out += e.out || 0;
  acc.cacheRead += e.cacheRead || 0;
  acc.cacheWrite += e.cacheWrite || 0;
  acc.total += e.total || 0;
  acc.steps += 1;
  acc.turns.add(`${e.sessionId}:${e.turnId}`);
}

const finalize = (a) => ({
  in: a.in,
  out: a.out,
  cacheRead: a.cacheRead,
  cacheWrite: a.cacheWrite,
  total: a.total,
  steps: a.steps,
  turns: a.turns.size,
});

function rowsOf(map) {
  return [...map].map(([key, acc]) => ({ key, ...finalize(acc) })).sort((x, y) => y.total - x.total);
}

export function summarize(entries, { window = "last", now = Date.now(), tz } = {}) {
  if (window === "last") {
    if (!entries.length) return { window, last: null };
    const lastE = entries[entries.length - 1];
    const key = `${lastE.sessionId}:${lastE.turnId}`;
    const acc = blank();
    let model = lastE.model;
    let source = lastE.source;
    let subagent = null;
    let when = lastE.ts;
    for (const e of entries) {
      if (`${e.sessionId}:${e.turnId}` !== key) continue;
      add(acc, e);
      model = e.model;
      source = e.source;
      when = e.ts;
      if (e.subagent) subagent = e.subagent;
    }
    return { window, last: { ...finalize(acc), model, source, subagent, when } };
  }

  if (window === "by-model" || window === "by-source") {
    const keyFn = window === "by-model" ? (e) => e.model || "?" : (e) => e.source || "?";
    const groups = new Map();
    const total = blank();
    for (const e of entries) {
      const k = keyFn(e);
      if (!groups.has(k)) groups.set(k, blank());
      add(groups.get(k), e);
      add(total, e);
    }
    return { window, rows: rowsOf(groups), totals: finalize(total) };
  }

  const win = entries.filter((e) => inWindow(e, window, now, tz));
  const total = blank();
  const bySource = new Map();
  const byModel = new Map();
  for (const e of win) {
    add(total, e);
    const s = e.source || "?";
    if (!bySource.has(s)) bySource.set(s, blank());
    add(bySource.get(s), e);
    const m = e.model || "?";
    if (!byModel.has(m)) byModel.set(m, blank());
    add(byModel.get(m), e);
  }
  return { window, totals: finalize(total), bySource: rowsOf(bySource), byModel: rowsOf(byModel) };
}

const WINDOW_LABEL = {
  last: "Last turn",
  today: "Today",
  week: "Last 7 days",
  month: "This month",
  "by-model": "By model",
  "by-source": "By source",
};

const SOURCE_LABEL = { telegram: "chat", http: "background (cron/digest)", unknown: "other" };
const src = (k) => {
  const key = String(k ?? "").replace(/^channel:/, "");
  return SOURCE_LABEL[key] || key || "other";
};
const num = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

export function formatUsageReport(agg) {
  const w = agg.window;
  if (w === "last") {
    if (!agg.last) return "No usage logged yet.";
    const l = agg.last;
    const sub = l.subagent ? ` (+subagent ${l.subagent})` : "";
    return [
      `Last turn: ${num(l.total)} tokens${sub}`,
      `in ${num(l.in)} · out ${num(l.out)}${l.cacheRead ? ` · cached ${num(l.cacheRead)}` : ""}`,
      `${plural(l.steps, "step")} · ${l.model} · ${src(l.source)}`,
    ].join("\n");
  }

  if (w === "by-model" || w === "by-source") {
    if (!agg.rows.length) return "No usage logged yet.";
    const lines = agg.rows.map(
      (r) => `• ${w === "by-source" ? src(r.key) : r.key}: ${num(r.total)} tokens (${plural(r.turns, "turn")})`,
    );
    return [`${WINDOW_LABEL[w]} (total ${num(agg.totals.total)} tokens):`, ...lines].join("\n");
  }

  const t = agg.totals;
  if (!t.steps) return `${WINDOW_LABEL[w]}: no usage.`;
  const out = [`${WINDOW_LABEL[w]}: ${num(t.total)} tokens (in ${num(t.in)} / out ${num(t.out)}) · ${plural(t.turns, "turn")}`];
  if (agg.bySource.length > 1) {
    out.push("Sources:");
    for (const r of agg.bySource) out.push(`• ${src(r.key)}: ${num(r.total)}`);
  }
  if (agg.byModel.length > 1) {
    out.push("Models:");
    for (const r of agg.byModel) out.push(`• ${r.key}: ${num(r.total)}`);
  }
  return out.join("\n");
}

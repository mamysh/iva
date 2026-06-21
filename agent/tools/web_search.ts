import { defineTool } from "eve/tools";
import { z } from "zod";

// Веб-поиск с выбором провайдера (SEARCH_PROVIDER: tavily|brave|exa|parallel).
// Если ключ выбранного провайдера не задан, мягко падаем назад на DuckDuckGo HTML:
// поиск остаётся рабочим "из коробки", а API-ключи дают более стабильный прод-режим.
// Каждый провайдер — пара чистых функций build()/parse() (SRP); провайдеры лежат в массиве
// PROVIDERS, а execute() диспетчеризует по нему, не зная реализаций (DIP). Новый бэкенд =
// добавить элемент в массив, плита fetch/normalize не трогается (OCP). Паттерн scripts/lib/ports.mjs.
// САМОДОСТАТОЧНО: только eve/tools, zod, node fetch (без cross-authored import — иначе ломается eve dev).
// Чтение страницы — web_fetch; интерактив/логин/JS — agent-browser.

const SNIPPET_MAX = 500; // усечение сниппета, чтобы поиск не раздувал контекст
const TITLE_MAX = 200;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fallthrough */
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

// ── мелкие безопасные геттеры (ответы провайдеров — нетипизированный JSON) ──
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const joinChunks = (v: unknown): string => arr(v).map(str).filter(Boolean).join(" … ");

type Normalized = { answer?: string; results: { title: string; url: string; snippet: string }[] };
type BuiltRequest = { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string };

interface SearchProvider {
  name: string; // совпадает со значением SEARCH_PROVIDER
  keyEnv: string; // переменная окружения с ключом
  signupUrl: string; // для понятных сообщений об ошибке/в doctor
  build(query: string, n: number, key: string): BuiltRequest; // чистый билдер запроса, без I/O
  parse(json: unknown): Normalized; // чистый парсер ответа → нормализованная форма
}

// ── адаптеры провайдеров (факты сверены по официальным докам, июнь 2026) ──
const PROVIDERS: SearchProvider[] = [
  {
    name: "tavily",
    keyEnv: "TAVILY_API_KEY",
    signupUrl: "https://app.tavily.com",
    build: (query, n, key) => ({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: n, search_depth: "basic", include_answer: "basic", topic: "general" }),
    }),
    parse: (json) => {
      const d = json as { answer?: unknown; results?: unknown };
      const results = arr(d.results).map((r) => {
        const it = r as { title?: unknown; url?: unknown; content?: unknown };
        return { title: str(it.title), url: str(it.url), snippet: str(it.content) };
      });
      return { answer: str(d.answer) || undefined, results };
    },
  },
  {
    name: "brave",
    keyEnv: "BRAVE_API_KEY",
    signupUrl: "https://api-dashboard.search.brave.com",
    build: (query, n, key) => ({
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(n, 20)}`,
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    }),
    parse: (json) => {
      const d = json as { web?: { results?: unknown } };
      const results = arr(d.web?.results).map((r) => {
        const it = r as { title?: unknown; url?: unknown; description?: unknown };
        return { title: str(it.title), url: str(it.url), snippet: str(it.description) };
      });
      return { results }; // web/search не отдаёт inline-answer
    },
  },
  {
    name: "exa",
    keyEnv: "EXA_API_KEY",
    signupUrl: "https://dashboard.exa.ai",
    build: (query, n, key) => ({
      url: "https://api.exa.ai/search",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      // без contents результаты приходят без текста — запрашиваем highlights/summary/text явно
      body: JSON.stringify({ query, type: "auto", numResults: n, contents: { text: true, highlights: true, summary: true } }),
    }),
    parse: (json) => {
      const d = json as { results?: unknown };
      const results = arr(d.results).map((r) => {
        const it = r as { title?: unknown; url?: unknown; highlights?: unknown; summary?: unknown; text?: unknown };
        return { title: str(it.title), url: str(it.url), snippet: joinChunks(it.highlights) || str(it.summary) || str(it.text) };
      });
      return { results }; // answer — только на отдельном /answer
    },
  },
  {
    name: "parallel",
    keyEnv: "PARALLEL_API_KEY",
    signupUrl: "https://platform.parallel.ai",
    build: (query, n, key) => ({
      url: "https://api.parallel.ai/v1/search",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      // search_queries обязателен; mode=basic — низкая латентность (advanced ~3с)
      body: JSON.stringify({ objective: query, search_queries: [query], mode: "basic", advanced_settings: { max_results: n } }),
    }),
    parse: (json) => {
      const d = json as { results?: unknown };
      const results = arr(d.results).map((r) => {
        const it = r as { title?: unknown; url?: unknown; excerpts?: unknown };
        return { title: str(it.title), url: str(it.url), snippet: joinChunks(it.excerpts) };
      });
      return { results }; // answer нет — отдаёт ранжированные excerpts
    },
  },
];

function pickProvider(): SearchProvider {
  const name = (process.env.SEARCH_PROVIDER || "tavily").trim().toLowerCase();
  return PROVIDERS.find((p) => p.name === name) ?? PROVIDERS[0]; // неизвестный → tavily
}

async function searchDuckDuckGo(query: string, n: number) {
  const attempts = [
    {
      url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      init: { headers: { "User-Agent": "Mozilla/5.0 (compatible; iva-agent/1.0)" } },
    },
    {
      url: "https://html.duckduckgo.com/html/",
      init: {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; iva-agent/1.0)",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(query)}`,
      },
    },
  ];

  let lastError = "";
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, attempt.init);
      if (!res.ok) {
        lastError = `DuckDuckGo HTTP ${res.status}`;
        continue;
      }
      const found = parseDuckDuckGoHtml(await res.text(), n);
      if (found.length) {
        const note = "DuckDuckGo fallback: для стабильного поиска на VPS лучше добавить ключ выбранного SEARCH_PROVIDER.";
        return { provider: "duckduckgo", results: found, note };
      }
      lastError = "DuckDuckGo не вернул распознаваемых результатов";
    } catch (e) {
      lastError = `DuckDuckGo сеть: ${(e as Error).message}`;
    }
  }

  return {
    provider: "duckduckgo",
    results: [],
    note: `Ничего не найдено. ${lastError}. Для стабильного поиска на VPS лучше добавить ключ выбранного SEARCH_PROVIDER.`,
  };
}

function parseDuckDuckGoHtml(html: string, n: number) {
  const snippets: string[] = [];
  const snippetRe = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/g;
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(clip(stripTags(sm[1]!), SNIPPET_MAX));
  const liteSnippetRe = /class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/g;
  while ((sm = liteSnippetRe.exec(html)) !== null) snippets.push(clip(stripTags(sm[1]!), SNIPPET_MAX));

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRe =
    /<a\b(?=[^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'])(?=[^>]*href=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < n) {
    results.push({
      title: clip(stripTags(m[2]!), TITLE_MAX),
      url: decodeHref(m[1]!),
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return results;
}

export default defineTool({
  description:
    "Поиск в интернете: API-провайдер из SEARCH_PROVIDER при наличии ключа, иначе DuckDuckGo fallback. " +
    "Возвращает top results: title, url, snippet (+ answer, если провайдер его даёт). Чтобы прочитать страницу — web_fetch; интерактив — agent-browser.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Поисковый запрос"),
    count: z.number().int().min(1).max(10).optional().describe("Сколько результатов (по умолчанию 5)"),
  }),
  async execute({ query, count }) {
    const n = Math.min(count ?? 5, 10);
    const provider = pickProvider();
    const key = (process.env[provider.keyEnv] || "").trim();
    if (!key) {
      return searchDuckDuckGo(query, n);
    }

    const req = provider.build(query, n, key);
    let res: Response;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    } catch (e) {
      return { error: `сеть: ${(e as Error).message}` };
    }

    if (res.status === 401 || res.status === 403) return { error: `${provider.name} отклонил ключ (401/403) — проверь ${provider.keyEnv}.` };
    if (res.status === 429) return { error: `${provider.name}: превышен лимит запросов (429) — попробуй позже.` };
    if (!res.ok) return { error: `${provider.name} HTTP ${res.status}` };

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      return { error: `${provider.name}: некорректный JSON (${(e as Error).message})` };
    }

    const norm = provider.parse(json);
    const results = norm.results
      .filter((r) => r.url)
      .slice(0, n)
      .map((r) => ({ title: clip(r.title, TITLE_MAX), url: r.url, snippet: clip(r.snippet, SNIPPET_MAX) }));
    const answer = norm.answer && norm.answer.trim() ? norm.answer.trim() : undefined;

    if (!results.length) return { provider: provider.name, results: [], ...(answer ? { answer } : {}), note: "Ничего не найдено." };
    return answer ? { provider: provider.name, answer, results } : { provider: provider.name, results };
  },
});

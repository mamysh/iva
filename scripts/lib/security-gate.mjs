// Deterministic security checks at the message boundary. They complement (not replace)
// the agent's instruction hierarchy: external text remains data, never authority.

const INVISIBLE = /[\p{Cf}\p{Cc}\u200b\u200c\u200d\u2060\ufeff]/gu;
const KEEP = new Set(["\n", "\r", "\t"]);
const ROLE_MARKER = /(?:^|\n)\s*(?:system|assistant|user|human|ai|instruction|admin|root|система|ассистент|инструкция)\s*[:\-]/gimu;
const OVERRIDES = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/iu,
  /forget\s+(?:all\s+)?(?:your\s+)?previous\s+instructions?/iu,
  /(?:new\s+)?system\s+instructions?\s*:/iu,
  /(?:reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/iu,
  /(?:send|forward|email|post)\s+(?:all\s+)?(?:data|files|secrets|keys|tokens)/iu,
  /игнорируй\s+(?:все\s+)?(?:предыдущие|прошлые)\s+инструкции/iu,
  /(?:раскрой|покажи|выведи)\s+(?:системн\w*\s+)?(?:промпт|инструкц\w*)/iu,
  /(?:отправь|перешли)\s+(?:все\s+)?(?:данные|файлы|секреты|ключи|токены)/iu,
];

export function sanitizeInbound(input, maxChars = 50_000) {
  const flags = [];
  let removed = 0;
  let text = String(input ?? "").replace(INVISIBLE, (char) => {
    if (KEEP.has(char)) return char;
    removed += 1;
    return "";
  });
  if (removed) flags.push(`invisible=${removed}`);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    flags.push("truncated");
  }

  const roleMarkers = (text.match(ROLE_MARKER) ?? []).length;
  const overrides = OVERRIDES.reduce((count, pattern) => count + Number(pattern.test(text)), 0);
  if (roleMarkers) flags.push(`role-markers=${roleMarkers}`);
  if (overrides) flags.push(`override-patterns=${overrides}`);

  const blocked = (roleMarkers >= 2 && overrides >= 1) || overrides >= 3;
  return {
    text,
    blocked,
    flags,
    reason: blocked ? `possible prompt injection (${roleMarkers} role markers, ${overrides} override patterns)` : "clean",
  };
}

const SECRET_PATTERNS = [
  /\b(?:sk|sk-ant)-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b(?:xoxb|xoxp)-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/gi,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*["']?[^\s"']{8,}/g,
  /\b(?:api[_-]?key|api[_-]?token|secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/gi,
];
const EXFIL_URL = /https?:\/\/[^\s)]+[?&](?:token|key|secret|api_key|password|auth)=[^\s&]{8,}/gi;

export function scanOutbound(input) {
  let text = String(input ?? "");
  const findings = [];
  for (const pattern of [...SECRET_PATTERNS, EXFIL_URL]) {
    text = text.replace(pattern, (match) => {
      findings.push(match.slice(0, 12));
      return "[REDACTED]";
    });
  }
  return { text, clean: findings.length === 0, findings };
}

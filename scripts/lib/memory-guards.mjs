export const CORE_CAP = 1200;

// Prompt-level durability contract for semantic distinctions that cannot be enforced reliably with
// keyword matching. The examples are synthetic and are also consumed by the behavioral canary.
export const MEMORY_DURABILITY_CASES = Object.freeze([
  {
    input: "Я сегодня бесполезен и всё испортил",
    classification: "transient-emotion",
    destination: "daily-summary",
    identity: false,
  },
  {
    input: "Я предпочитаю короткие ответы без длинной преамбулы",
    classification: "durable-preference",
    destination: "CORE",
    identity: true,
  },
  {
    input: "Запомни: приступы тревоги повторяются несколько месяцев",
    classification: "explicit-contextual-fact",
    destination: "archived-note",
    identity: false,
  },
]);

export function emotionalMemoryPolicy() {
  return (
    `Emotional venting and momentary states (for example, "I'm useless", "I wasted the day", ` +
    `tiredness, frustration or a bad mood) are NEVER identity-level facts: do not put them into CORE ` +
    `or contact/project/entity cards. At most preserve a dated, contextual mood line in the ` +
    `daily-summary; only when explicitly requested or durably relevant, use an archived note without ` +
    `turning the state into an identity label. A stable preference stated by the user may still be ` +
    `durable. A lasting medical or historical fact the user explicitly asks to remember must be kept ` +
    `as contextual information, not as a personality judgment. `
  );
}

export function coreRecoveryAction(before, after, cap = CORE_CAP) {
  if (typeof after === "string" && after.trim() && after.length <= cap) return "accept";
  if (typeof before === "string" && before.trim() && before.length <= cap) return "restore";
  return "fail";
}

export function gitPushFailureAlert(output, vault) {
  const text = String(output ?? "");
  if (/GH001|large files detected|exceeds GitHub(?:'s)? file size limit|pre-receive hook declined/i.test(text)) {
    return (
      "vault: git push was rejected because the pending history contains oversized files; " +
      "credentials are working. Inspect the memory-doctor journal and repair the large blobs before retrying."
    );
  }
  if (/authentication failed|could not read username|permission denied|repository not found|HTTP 403/i.test(text)) {
    return (
      "vault: git push authentication failed. On the server run `gh auth status`, then " +
      `verify remote access (cd ${vault} && git push).`
    );
  }
  return (
    "vault: git push failed for a non-authentication reason. " +
    "Inspect `journalctl --user -u iva-memory-doctor.service` before retrying."
  );
}

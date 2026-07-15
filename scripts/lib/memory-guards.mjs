export const CORE_CAP = 1200;

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

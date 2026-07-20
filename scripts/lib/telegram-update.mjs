// Pure self-update helpers shared by the Telegram bridge and its regression tests.
// The bridge supplies a git runner; this module owns comparison semantics only.

export const CONTROL_COMMANDS = Object.freeze([
  "/help",
  "/usage",
  "/reminders",
  "/restart",
  "/new",
  "/clear",
  "/compact",
  "/update",
  "/model",
  "/think",
]);

export function packageVersion(jsonText) {
  try {
    return JSON.parse(jsonText).version || null;
  } catch {
    return null;
  }
}

export function parseUpdateAction(data) {
  if (data === "iva_update:do") return "do";
  if (data === "iva_update:skip") return "skip";
  return null;
}

export async function checkDeploymentUpdate(runGit) {
  const branch = (await runGit("rev-parse", "--abbrev-ref", "HEAD")) || "main";
  await runGit("fetch", "--prune", "origin", branch);

  const local = await runGit("rev-parse", "HEAD");
  const remote = await runGit("rev-parse", `origin/${branch}`);
  const behindText = await runGit("rev-list", "--count", `HEAD..origin/${branch}`);
  const aheadText = await runGit("rev-list", "--count", `origin/${branch}..HEAD`);
  if (!/^\d+$/.test(behindText)) throw new Error(`invalid git behind count: ${behindText || "empty"}`);
  if (!/^\d+$/.test(aheadText)) throw new Error(`invalid git ahead count: ${aheadText || "empty"}`);

  const behind = Number(behindText);
  const ahead = Number(aheadText);
  const localVer = packageVersion(await runGit("show", "HEAD:package.json"));
  const remoteVer = packageVersion(await runGit("show", `origin/${branch}:package.json`));
  return { branch, local, remote, behind, ahead, rewritten: ahead > 0, localVer, remoteVer, hasUpdate: local !== remote };
}

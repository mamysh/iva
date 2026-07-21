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
  if (data === "iva_update:later") return "later";
  if (data === "iva_update:view") return "view";
  return null;
}

export async function checkDeploymentUpdate(runGit, channel) {
  if (channel?.remote !== "origin" || channel?.branch !== "main") {
    throw new Error("update channel blocked: only origin/main is allowed");
  }
  const { remote: remoteName, branch } = channel;
  const targetRef = `${remoteName}/${branch}`;
  await runGit("fetch", "--prune", remoteName, branch);

  const local = await runGit("rev-parse", "HEAD");
  const remote = await runGit("rev-parse", targetRef);
  const behindText = await runGit("rev-list", "--count", `HEAD..${targetRef}`);
  const aheadText = await runGit("rev-list", "--count", `${targetRef}..HEAD`);
  if (!/^\d+$/.test(behindText)) throw new Error(`invalid git behind count: ${behindText || "empty"}`);
  if (!/^\d+$/.test(aheadText)) throw new Error(`invalid git ahead count: ${aheadText || "empty"}`);

  const behind = Number(behindText);
  const ahead = Number(aheadText);
  const localVer = packageVersion(await runGit("show", "HEAD:package.json"));
  const remoteVer = packageVersion(await runGit("show", `${targetRef}:package.json`));
  return { channel: targetRef, branch, local, remote, behind, ahead, rewritten: ahead > 0, localVer, remoteVer, hasUpdate: local !== remote };
}

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const UPDATE_CHANNEL_SCHEMA_VERSION = 1;
export const UPDATE_CHANNEL_STATE_FILE = "update-channel.json";
export const PRODUCTION_UPDATE_CHANNEL = Object.freeze({ remote: "origin", branch: "main" });
export const STABLE_UPDATE_CHANNEL = Object.freeze({ remote: "origin", branch: "stable" });
export const ALLOWED_UPDATE_CHANNELS = Object.freeze([
  PRODUCTION_UPDATE_CHANNEL,
  STABLE_UPDATE_CHANNEL,
]);

function channelError(message) {
  return new Error(`update channel blocked: ${message}`);
}

export function validateUpdateChannel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw channelError("state must be an object");
  }
  if (value.schemaVersion !== UPDATE_CHANNEL_SCHEMA_VERSION) {
    throw channelError("unsupported state schema");
  }
  if (!ALLOWED_UPDATE_CHANNELS.some(({ remote, branch }) => value.remote === remote && value.branch === branch)) {
    throw channelError("only origin/main or origin/stable is allowed");
  }
  return { remote: value.remote, branch: value.branch };
}

export function updateChannelRef(channel) {
  const validated = validateUpdateChannel({ schemaVersion: UPDATE_CHANNEL_SCHEMA_VERSION, ...channel });
  return `${validated.remote}/${validated.branch}`;
}

export function updateChannelStatePath(dataDir) {
  return join(dataDir, UPDATE_CHANNEL_STATE_FILE);
}

export function writeUpdateChannelState(dataDir, channel = PRODUCTION_UPDATE_CHANNEL) {
  const validated = validateUpdateChannel({ schemaVersion: UPDATE_CHANNEL_SCHEMA_VERSION, ...channel });
  const path = updateChannelStatePath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: UPDATE_CHANNEL_SCHEMA_VERSION, ...validated }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, channel: validated };
}

export function readUpdateChannelState(dataDir) {
  const path = updateChannelStatePath(dataDir);
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw channelError("state is not a regular file");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw channelError("state is not valid JSON");
  }
  const channel = validateUpdateChannel(parsed);
  chmodSync(path, 0o600);
  return { path, channel };
}

function requireGit(runGit, args, description) {
  const result = runGit(args);
  if (!result || result.code !== 0) throw channelError(description);
  const out = String(result.out || "").trim();
  if (!out) throw channelError(description);
  return out;
}

// Resolve once, then keep the explicit state independent of future checkout/merge operations.
// Legacy installs are migrated only from their factual tracking branch; a guessed current branch
// would let a temporary integration checkout silently become the production update channel.
export function resolveUpdateChannel({ dataDir, runGit, persist = true, requireCheckout = false } = {}) {
  if (!dataDir || typeof runGit !== "function") throw new Error("update channel resolver requires dataDir and runGit");
  const currentBranch = requireGit(runGit, ["rev-parse", "--abbrev-ref", "HEAD"], "detached HEAD or current branch is unavailable");
  if (currentBranch === "HEAD") throw channelError("detached HEAD; switch to an attached branch first");

  const configured = readUpdateChannelState(dataDir);
  if (configured) {
    if (requireCheckout && currentBranch !== configured.channel.branch) {
      throw channelError(
        `current branch ${currentBranch} does not match ${updateChannelRef(configured.channel)}; switch to ${configured.channel.branch} first`,
      );
    }
    return { ...configured, currentBranch, migrated: false };
  }

  const tracking = requireGit(
    runGit,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    "legacy install has no tracking branch",
  );
  const channel = ALLOWED_UPDATE_CHANNELS.find(({ remote, branch }) => tracking === `${remote}/${branch}`);
  if (!channel) {
    throw channelError(`legacy tracking branch ${tracking} is not allowed; expected origin/main or origin/stable`);
  }
  if (requireCheckout && currentBranch !== channel.branch) {
    throw channelError(`current branch ${currentBranch} does not match ${updateChannelRef(channel)}; switch to ${channel.branch} first`);
  }
  const selected = { ...channel };
  const written = persist ? writeUpdateChannelState(dataDir, selected) : { path: null, channel: selected };
  return { ...written, currentBranch, migrated: true };
}

#!/usr/bin/env node
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCTION_UPDATE_CHANNEL, writeUpdateChannelState } from "./lib/update-channel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const requestedBranch = process.argv[2] || PRODUCTION_UPDATE_CHANNEL.branch;
if (requestedBranch !== PRODUCTION_UPDATE_CHANNEL.branch) {
  throw new Error(`update channel blocked: only origin/${PRODUCTION_UPDATE_CHANNEL.branch} is allowed`);
}
const configuredDataDir = process.env.ASSISTANT_DATA_DIR || "data";
const dataDir = isAbsolute(configuredDataDir) ? configuredDataDir : join(ROOT, configuredDataDir);
writeUpdateChannelState(dataDir, PRODUCTION_UPDATE_CHANNEL);
console.log(`Update channel: ${PRODUCTION_UPDATE_CHANNEL.remote}/${PRODUCTION_UPDATE_CHANNEL.branch}`);

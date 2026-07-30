#!/usr/bin/env node
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCTION_UPDATE_CHANNEL, writeUpdateChannelState } from "./lib/update-channel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const requestedBranch = process.argv[2] || PRODUCTION_UPDATE_CHANNEL.branch;
const requestedChannel = { remote: "origin", branch: requestedBranch };
const configuredDataDir = process.env.ASSISTANT_DATA_DIR || "data";
const dataDir = isAbsolute(configuredDataDir) ? configuredDataDir : join(ROOT, configuredDataDir);
writeUpdateChannelState(dataDir, requestedChannel);
console.log(`Update channel: ${requestedChannel.remote}/${requestedChannel.branch}`);

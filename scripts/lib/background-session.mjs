import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

function statePath(key, env = process.env, cwd = process.cwd()) {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Invalid background session key: ${key}`);
  const configured = env.ASSISTANT_DATA_DIR || "data";
  const dataDir = isAbsolute(configured) ? configured : resolve(cwd, configured);
  return join(dataDir, "background-sessions", `${key}.json`);
}

export async function loadBackgroundSession(client, key, options = {}) {
  const path = statePath(key, options.env, options.cwd);
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    return client.session(state);
  } catch {
    return client.session();
  }
}

export async function saveBackgroundSession(session, key, options = {}) {
  const path = statePath(key, options.env, options.cwd);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session.state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

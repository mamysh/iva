import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const LEGACY_LOCAL_WORKFLOW_DATA_RELATIVE_PATH = ".workflow-data";
export const LOCAL_WORKFLOW_DATA_RELATIVE_PATH = ".eve/.workflow-data";

export function legacyLocalWorkflowDataPath(root) {
  return resolve(root, LEGACY_LOCAL_WORKFLOW_DATA_RELATIVE_PATH);
}

export function localWorkflowDataPath(root) {
  return resolve(root, LOCAL_WORKFLOW_DATA_RELATIVE_PATH);
}

export function existingLocalWorkflowDataPath(root) {
  const state = inspectLocalWorkflowState(root);
  return state.currentExists ? state.currentPath : state.legacyPath;
}

export function inspectLocalWorkflowState(root) {
  const legacyPath = legacyLocalWorkflowDataPath(root);
  const currentPath = localWorkflowDataPath(root);
  return {
    legacyPath,
    currentPath,
    legacyExists: existsSync(legacyPath),
    currentExists: existsSync(currentPath),
  };
}

export function directorySnapshot(path) {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("local workflow state must be a real directory");
  }
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("local workflow state cannot contain symbolic links");
    if (entry.isDirectory()) {
      const nested = directorySnapshot(child);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += lstatSync(child).size;
    } else {
      throw new Error("local workflow state cannot contain special files");
    }
  }
  return { files, bytes };
}

export function migrateLocalWorkflowState({ root, processId = process.pid } = {}) {
  if (!root) throw new Error("local workflow migration requires an explicit root");
  const state = inspectLocalWorkflowState(root);
  if (state.currentExists) {
    directorySnapshot(state.currentPath);
    return { outcome: "current", ...state };
  }
  if (!state.legacyExists) return { outcome: "fresh", ...state };

  const sourceSnapshot = directorySnapshot(state.legacyPath);
  if (sourceSnapshot.files === 0) throw new Error("legacy local workflow state is empty");
  const parent = resolve(root, ".eve");
  const temporary = join(parent, `.workflow-data.migrating-${processId}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  rmSync(temporary, { recursive: true, force: true });
  try {
    cpSync(state.legacyPath, temporary, { recursive: true, preserveTimestamps: true });
    const copiedSnapshot = directorySnapshot(temporary);
    if (copiedSnapshot.files !== sourceSnapshot.files || copiedSnapshot.bytes !== sourceSnapshot.bytes) {
      throw new Error("local workflow state copy could not be verified");
    }
    renameSync(temporary, state.currentPath);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    outcome: "migrated",
    ...inspectLocalWorkflowState(root),
    sourceSnapshot,
  };
}

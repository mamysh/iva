#!/usr/bin/env node
import { resolve } from "node:path";
import { migrateLocalWorkflowState } from "./lib/local-workflow-state.mjs";

const rootIndex = process.argv.indexOf("--root");
const selectedRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
if (!selectedRoot) throw new Error("usage: migrate-local-workflow-state --root <installed-iva-root>");

const result = migrateLocalWorkflowState({ root: resolve(process.cwd(), selectedRoot) });
console.log(`local Workflow state: ${result.outcome}`);

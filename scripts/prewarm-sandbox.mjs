import { prewarmBuiltAppSandboxes } from "../node_modules/eve/dist/src/execution/sandbox/prewarm.js";

await prewarmBuiltAppSandboxes({
  appRoot: process.cwd(),
  log: (message) => console.log(message),
});

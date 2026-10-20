import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";

await createFindTool(process.cwd()).execute("install-find", { pattern: "package.json", limit: 1 });
await createGrepTool(process.cwd()).execute("install-grep", { pattern: '"name"', path: "package.json", limit: 1 });
console.log("Pi search tools ready");

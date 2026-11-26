const subcommand = process.argv[2];
if (subcommand === "sync") await import("./workflow-sync.ts");
else await import("./workflow-commands.ts");

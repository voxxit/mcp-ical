#!/usr/bin/env node

// Simple startup script that shows instructions if run directly
const { spawn } = require("child_process");
const path = require("path");

if (require.main === module) {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                        iCal MCP Server Setup                       ║
╠════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  This server should be run through Claude Desktop, not directly.  ║
║                                                                    ║
║  Quick Setup:                                                      ║
║                                                                    ║
║  1. Build the project:                                             ║
║     npm install && npm run build                                   ║
║                                                                    ║
║  2. Add to Claude Desktop config:                                 ║
║     - macOS: ~/Library/Application Support/Claude/                ║
║               claude_desktop_config.json                           ║
║     - Windows: %APPDATA%\\Claude\\claude_desktop_config.json         ║
║                                                                    ║
║  3. Add this configuration:                                        ║
║                                                                    ║
║     "mcpServers": {                                                ║
║       "ical-mcp": {                                                ║
║         "command": "node",                                         ║
║         "args": ["${path.resolve(__dirname, "dist/index.js")}"],   ║
║         "env": {                                                   ║
║           "CALENDAR_URL": "your-calendar-url.ics"                  ║
║         }                                                          ║
║       }                                                            ║
║     }                                                              ║
║                                                                    ║
║  4. Restart Claude Desktop                                         ║
║                                                                    ║
║  For more information, see README.md                               ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝

Current installation path: ${__dirname}
`);

  // If they really want to run it directly for testing
  if (process.argv.includes("--test")) {
    const child = spawn("node", [path.join(__dirname, "dist/index.js")], {
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("exit", (code) => {
      process.exit(code);
    });
  }
}

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupServer } from "./server-setup.js";
import { CalendarManager } from "./calendar-manager.js";
import { TimezoneManager } from "./timezone-manager.js";

// Create a single CalendarManager instance to share between server and auto-subscription
const calendarManager = new CalendarManager();
const server = setupServer(calendarManager);
const timezoneManager = TimezoneManager.getInstance();

async function main() {
  // Print startup message with instructions
  console.error(`
╔════════════════════════════════════════════════════════════════════╗
║                        iCal MCP Server v1.0.2                      ║
╠════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  A Model Context Protocol server for iCalendar subscriptions!      ║
║                                                                    ║
║  To add this server to your Claude Desktop configuration:          ║
║                                                                    ║
║  1. Open your Claude Desktop config:                               ║
║     - macOS: ~/Library/Application Support/Claude/                 ║
║               claude_desktop_config.json                           ║
║     - Windows: %APPDATA%\\Claude\\claude_desktop_config.json       ║
║                                                                    ║
║  2. Add to the "mcpServers" section:                               ║
║                                                                    ║
║     "ical-mcp": {                                                  ║
║       "command": "npx",                                            ║
║       "args": ["-y", "@voxxit/mcp-ical"],                          ║
║       "env": {                                                     ║
║         "CALENDAR_URL": "your-calendar-url.ics",                   ║
║         "CALENDAR_NAME": "My Calendar",                            ║
║         "CALENDAR_REFRESH_INTERVAL": "60"                          ║
║       }                                                            ║
║     }                                                              ║
║                                                                    ║
║  3. Restart Claude Desktop                                         ║
║                                                                    ║
║  Environment Variables (optional):                                 ║
║  - CALENDAR_URL: Auto-subscribe to this calendar on startup        ║
║  - CALENDAR_NAME: Name for the auto-subscribed calendar            ║
║  - CALENDAR_REFRESH_INTERVAL: Refresh interval in minutes          ║
║  - TZ: Timezone (e.g., America/New_York, Europe/London)            ║
║                                                                    ║
║  Available Tools:                                                  ║
║  • subscribe_calendar - Subscribe to an iCalendar feed             ║
║  • list_calendars - List all subscribed calendars                  ║
║  • unsubscribe_calendar - Remove a calendar subscription           ║
║  • get_events - Get events within a date range                     ║
║  • search_events - Search events by text                           ║
║  • get_upcoming_events - Get upcoming events                       ║
║  • get_daily_agenda - Get today's 9-5 agenda in your timezone      ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Auto-subscribe to calendar if CALENDAR_URL is provided
  const calendarUrl = process.env.CALENDAR_URL;
  if (calendarUrl) {
    try {
      const calendarName = process.env.CALENDAR_NAME || "Default Calendar";
      const refreshInterval = parseInt(process.env.CALENDAR_REFRESH_INTERVAL || "60");
      
      console.error(`\n🔄 Auto-subscribing to calendar...`);
      await calendarManager.subscribeCalendar(calendarUrl, calendarName, refreshInterval);
      console.error(`✅ Successfully subscribed to: ${calendarName}`);
      console.error(`   Refresh interval: ${refreshInterval} minutes\n`);
    } catch (error) {
      console.error(`\n❌ Failed to auto-subscribe to calendar: ${error}\n`);
    }
  } else {
    console.error(`\n💡 Tip: Set CALENDAR_URL environment variable to auto-subscribe on startup\n`);
  }
  
  console.error(`🚀 iCal MCP Server is ready!`);
  console.error(`🌍 Timezone: ${timezoneManager.getTimezone()}\n`);
}

main().catch(console.error);
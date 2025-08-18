# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Build & Development
- `npm run build` - Compile TypeScript to JavaScript (outputs to dist/)
- `npm run dev` - Build and run the server
- `npm start` - Run the compiled server (dist/index.js)
- `npm run setup` - Display setup instructions for Claude Desktop

### Testing
- `npm test` - Run all tests with Jest
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate test coverage report
- `npm run test:manual` - Build and run manual test file

To run a single test file:
```bash
npx jest src/__tests__/specific-test.test.ts
```

### Pre-publish
- `npm run prepublishOnly` - Build and test before publishing (runs automatically)

## Architecture Overview

### Core Components

1. **MCP Server Implementation** (`src/index.ts`, `src/server-setup.ts`)
   - Implements Model Context Protocol server using `@modelcontextprotocol/sdk`
   - Exposes 7 tools for calendar operations
   - Auto-subscribes to calendars via environment variables
   - Uses StdioServerTransport for communication with Claude Desktop

2. **Calendar Management** (`src/calendar-manager.ts`)
   - Manages multiple iCalendar subscriptions
   - Implements caching with configurable refresh intervals using `node-cache`
   - Persists subscriptions to `~/.ical-mcp-config.json`
   - Handles iCal parsing via `node-ical` library
   - Processes recurring events using `rrule`

3. **Timezone Handling** (`src/timezone-manager.ts`)
   - Singleton pattern for consistent timezone management
   - Detects system timezone or uses TZ environment variable
   - Provides date formatting utilities

### Tool Implementation Pattern

Tools are defined in `server-setup.ts` with:
- Tool metadata in `listToolsHandler`
- Implementation logic in `callToolHandler` switch statement
- Date parsing uses local timezone, not UTC (important for date range queries)

### Testing Strategy

- Uses Jest with ts-jest preset
- Test files located in `src/__tests__/`
- Uses `nock` for HTTP mocking in tests
- Test helpers in `src/__tests__/test-helpers.ts`

## Key Implementation Notes

- All dates in tool inputs (YYYY-MM-DD format) are interpreted in local timezone
- Calendar subscriptions persist across server restarts
- Cache TTL is per-calendar based on refresh interval
- The server displays startup instructions and status in stderr
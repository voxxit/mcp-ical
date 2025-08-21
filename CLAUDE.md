# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Initial Setup

**IMPORTANT**: Before starting any development work, ensure husky hooks and Qlty are installed:

```bash
npm install
npm run prepare  # This installs the husky git hooks
curl https://qlty.sh | sh  # Install Qlty code quality platform
```

The repository has pre-commit hooks configured that will:

- Run ESLint with auto-fix on staged TypeScript/JavaScript files
- Run Prettier to format all staged files
- Run TypeScript type checking on source files
- Run Qlty code quality checks on all files

These hooks are already configured and will run automatically on `git commit`.

## Common Development Commands

### Build & Development

- `npm run build` - Compile TypeScript to JavaScript (outputs to dist/)
- `npm run dev` - Build and run the local MCP server
- `npm start` - Run the compiled server (dist/index.js)
- `npm run setup` - Display setup instructions for Claude Desktop

### Cloudflare Worker Development

- `npm run build:worker` - Build the Worker TypeScript
- `npm run dev:worker` - Run Worker locally on http://localhost:8787
- `npm run deploy` - Deploy Worker to production
- `npm run deploy:preview` - Deploy Worker to preview environment
- `npm run setup:kv` - Create KV namespaces for Worker
- `npm run types` - Generate Worker types from wrangler.toml

### Testing

- `npm test` - Run all tests with Jest (runs in band)
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate test coverage report
- `npm run test:manual` - Build and run manual test file

To run a single test file:

```bash
npx jest src/__tests__/specific-test.test.ts
```

### Publishing to npm

- `npm version patch/minor/major` - Update version following semantic versioning
- `npm publish --access public` - Publish to npm registry
- `npm run prepublishOnly` - Build and test before publishing (runs automatically)

### Code Quality

- `npx eslint src/**/*.ts` - Run ESLint on TypeScript files
- `npx prettier --check .` - Check code formatting
- `npx lint-staged` - Run pre-commit checks manually

## Architecture Overview

### Dual Deployment Model

This project supports two deployment modes with different storage backends:

1. **Local MCP Server** (for Claude Desktop)
   - Stores calendars in `~/.ical-mcp-config.json`
   - Runs via StdioServerTransport
   - Configured through environment variables

2. **Cloudflare Worker** (for remote access)
   - Stores calendars in KV namespace with user isolation
   - Provides SSE endpoint for remote MCP clients
   - Includes web dashboard with Clerk authentication
   - OAuth 2.0 discovery endpoints for compatibility

### Core Components

1. **MCP Server Implementation** (`src/index.ts`, `src/server-setup.ts`)
   - Implements Model Context Protocol server using `@modelcontextprotocol/sdk`
   - Exposes 7 tools for calendar operations
   - Auto-subscribes to calendars via environment variables
   - Uses StdioServerTransport for communication with Claude Desktop

2. **Calendar Management** (`src/calendar-manager.ts`)
   - Manages multiple iCalendar subscriptions
   - Implements caching with configurable refresh intervals using `node-cache`
   - Persists subscriptions to `~/.ical-mcp-config.json` (local mode)
   - Handles iCal parsing via `node-ical` library
   - Processes recurring events using `rrule`
   - Security validation for URLs, names, and date ranges

3. **Timezone Handling** (`src/timezone-date-manager.ts`)
   - Uses Temporal API with polyfill for robust timezone operations
   - Detects system timezone or uses TZ environment variable
   - Provides date formatting and parsing utilities
   - Replaces deprecated `timezone-manager.ts`

4. **Worker Implementation** (`src/worker-auth.ts`)
   - Cloudflare Worker with Durable Objects for state management
   - KV namespace for calendar storage with user isolation
   - Clerk authentication integration
   - Web dashboard for calendar management
   - SSE endpoint for MCP protocol communication

5. **Security Configuration** (`src/security-config.ts`)
   - Singleton for security settings and validation
   - URL validation to prevent SSRF attacks
   - Input sanitization for calendar names and queries
   - Rate limiting for RRULE processing

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
- Coverage reports in HTML and LCOV formats

## Key Implementation Notes

- All dates in tool inputs (YYYY-MM-DD format) are interpreted in local timezone
- Calendar subscriptions persist across server restarts
- Cache TTL is per-calendar based on refresh interval
- The server displays startup instructions and status in stderr
- Worker and local server have separate storage - calendars don't sync between them
- NEVER bypass pre-commit hooks
- When adding Cloudflare Worker environment variables, update types with `npm run types`

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.

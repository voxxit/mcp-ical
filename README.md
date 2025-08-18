# @voxxit/mcp-ical

![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/voxxit/mcp-ical?utm_source=oss&utm_medium=github&utm_campaign=voxxit%2Fmcp-ical&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

An MCP (Model Context Protocol) server that subscribes to iCalendar (.ics) feeds, caches them locally, and provides tools to query calendar events.

## Features

- Subscribe to multiple iCalendar feeds
- Automatic caching with configurable refresh intervals
- Search and filter events by date range, calendar, or text
- Persistent storage of calendar subscriptions
- RFC 5545 compliant iCalendar parsing

## Installation

### As an MCP Server for Claude Desktop

```bash
npx @voxxit/mcp-ical
```

### As a Package

```bash
npm install @voxxit/mcp-ical
```

### From Source

```bash
git clone https://github.com/voxxit/mcp-ical.git
cd mcp-ical
npm install
npm run build
```

## Publishing to npm

### Prerequisites

1. Create an npm account at https://www.npmjs.com/signup
2. Login to npm from your terminal:
   ```bash
   npm login
   ```

### Publishing Steps

1. Update the version in `package.json` following semantic versioning:

   ```bash
   npm version patch  # for bug fixes
   npm version minor  # for new features
   npm version major  # for breaking changes
   ```

2. Build the project:

   ```bash
   npm run build
   ```

3. Publish to npm:

   ```bash
   npm publish --access public
   ```

4. Create a git tag for the release:
   ```bash
   git push origin main --tags
   ```

### Publishing Checklist

- [ ] All tests pass (`npm test`)
- [ ] TypeScript builds without errors (`npm run build`)
- [ ] README is up to date
- [ ] Version number is updated in package.json
- [ ] CHANGELOG is updated (if applicable)
- [ ] No sensitive information in code or config files

## Usage

### Setup Instructions

For setup instructions and configuration help:

```bash
npm run setup
```

This will display detailed instructions for adding the server to Claude Desktop.

### Running the Server

The server should be run through Claude Desktop. When started, it displays:

- Configuration instructions
- Available tools
- Auto-subscription status (if CALENDAR_URL is set)

```bash
npm start  # For manual testing only
```

### Available Tools

1. **subscribe_calendar** - Subscribe to an iCalendar feed
   - `url`: The URL of the .ics file
   - `name`: A friendly name for the calendar
   - `refreshInterval`: How often to refresh in minutes (default: 60)

2. **list_calendars** - List all subscribed calendars

3. **unsubscribe_calendar** - Remove a calendar subscription
   - `name`: The calendar name to unsubscribe

4. **get_events** - Get events within a date range
   - `startDate`: Start date (YYYY-MM-DD)
   - `endDate`: End date (YYYY-MM-DD)
   - `calendarName`: Optional specific calendar
   - `limit`: Max events to return (default: 50)

5. **search_events** - Search events by text
   - `query`: Text to search in summaries and descriptions
   - `calendarName`: Optional specific calendar
   - `startDate`: Optional start date filter
   - `endDate`: Optional end date filter

6. **get_upcoming_events** - Get upcoming events
   - `days`: Number of days to look ahead (default: 7)
   - `calendarName`: Optional specific calendar
   - `limit`: Max events to return (default: 20)

7. **get_daily_agenda** - Get work day agenda (9-5) in current timezone
   - `date`: Optional date (YYYY-MM-DD), defaults to today
   - `calendarName`: Optional specific calendar
   - `startHour`: Work day start hour (default: 9)
   - `endHour`: Work day end hour (default: 17)

## Configuration

Calendar subscriptions are saved to `~/.ical-mcp-config.json`

### Environment Variables

You can automatically subscribe to a calendar on startup using environment variables:

- `CALENDAR_URL` - The URL of the iCalendar feed to subscribe to
- `CALENDAR_NAME` - The name for the calendar (default: "Default Calendar")
- `CALENDAR_REFRESH_INTERVAL` - Refresh interval in minutes (default: 60)
- `TZ` - Timezone for date/time operations (e.g., "America/New_York", "Europe/London"). If not set, the server will attempt to detect your system timezone.

Example:

```bash
CALENDAR_URL="https://example.com/calendar.ics" npm start
```

## Claude Desktop Configuration

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ical-mcp": {
      "command": "npx",
      "args": ["-y", "@voxxit/mcp-ical"],
      "env": {
        "CALENDAR_URL": "https://your-calendar-url.ics",
        "CALENDAR_NAME": "My Calendar",
        "CALENDAR_REFRESH_INTERVAL": "60"
      }
    }
  }
}
```

**Note**: You can also use a local installation:

```json
{
  "mcpServers": {
    "ical-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@voxxit/mcp-ical/dist/index.js"],
      "env": {
        "CALENDAR_URL": "https://your-calendar-url.ics",
        "CALENDAR_NAME": "My Calendar",
        "CALENDAR_REFRESH_INTERVAL": "60"
      }
    }
  }
}
```

## Example Usage

```javascript
// Subscribe to a calendar
await subscribe_calendar({
  url: "https://example.com/calendar.ics",
  name: "Work Calendar",
  refreshInterval: 30,
});

// Get upcoming events for the next 7 days
await get_upcoming_events({
  days: 7,
  limit: 10,
});

// Search for events containing "meeting"
await search_events({
  query: "meeting",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
});
```

## Caching

The server implements intelligent caching:

- Each calendar is cached according to its refresh interval
- Cache is automatically refreshed when expired
- Manual refresh occurs on each subscription update

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

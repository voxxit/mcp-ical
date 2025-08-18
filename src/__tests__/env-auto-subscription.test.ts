import { CalendarManager } from "../calendar-manager";
import { setupServer } from "../server-setup";
import nock from "nock";
import fs from "fs/promises";
import path from "path";

describe("Environment Variable Auto-subscription", () => {
  let configPath: string;

  beforeEach(async () => {
    // Clean up any existing config
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    configPath = path.join(homeDir, ".ical-mcp-config.json");
    try {
      await fs.unlink(configPath);
    } catch (_error) {
      // File doesn't exist, that's fine
    }
  });

  afterEach(async () => {
    // Clean up config after each test
    try {
      await fs.unlink(configPath);
    } catch (_error) {
      // File doesn't exist, that's fine
    }
    nock.cleanAll();
  });

  it("should ensure auto-subscription uses the same CalendarManager instance as server tools", async () => {
    // Mock the calendar URL
    const mockCalendarData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:env-test-event-1
SUMMARY:Environment Test Event
DTSTART:20250115T100000Z
DTEND:20250115T110000Z
END:VEVENT
END:VCALENDAR`;

    nock("https://example.com")
      .get("/env-calendar.ics")
      .reply(200, mockCalendarData, {
        "Content-Type": "text/calendar",
      });

    // Simulate the index.ts flow
    // 1. Create CalendarManager instance
    const calendarManager = new CalendarManager();

    // 2. Pass it to setupServer
    const server = setupServer(calendarManager);

    // 3. Use the same instance for auto-subscription
    await calendarManager.subscribeCalendar(
      "https://example.com/env-calendar.ics",
      "Env Test Calendar",
      60,
    );

    // 4. Verify the server tools see the same calendar
    const handlers = (server as any).getRequestHandlers();
    const callToolHandler = handlers.get("tools/call");

    // List calendars using the tool
    const listResponse = await callToolHandler({
      params: {
        name: "list_calendars",
        arguments: {},
      },
    });

    // Should see the auto-subscribed calendar
    expect(listResponse.content[0].text).toContain("Env Test Calendar");
    expect(listResponse.content[0].text).toContain(
      "https://example.com/env-calendar.ics",
    );

    // The calendar manager should have exactly one calendar
    const calendars = calendarManager.listCalendars();
    expect(calendars).toHaveLength(1);
    expect(calendars[0].name).toBe("Env Test Calendar");
  });
});

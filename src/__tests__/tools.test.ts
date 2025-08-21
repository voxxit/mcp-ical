import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupServer } from "../server-setup";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import {
  createIsolatedTestEnvironment,
  cleanupIsolatedTestEnvironment,
} from "./test-helpers";

// Mock calendar response data
const mockCalendarData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test1@example.com
DTSTART:20250815T140000Z
DTEND:20250815T150000Z
SUMMARY:Test Meeting 1
DESCRIPTION:This is a test meeting
LOCATION:Conference Room A
END:VEVENT
BEGIN:VEVENT
UID:test2@example.com
DTSTART:20250816T100000Z
DTEND:20250816T110000Z
SUMMARY:Daily Standup
DESCRIPTION:Team standup meeting
LOCATION:Virtual
END:VEVENT
BEGIN:VEVENT
UID:test3@example.com
DTSTART:20250820T180000Z
DTEND:20250820T200000Z
SUMMARY:Quarterly Review Meeting
DESCRIPTION:Quarterly review presentation
LOCATION:Main Office
END:VEVENT
END:VCALENDAR`;

describe("MCP Server Tools", () => {
  let server: any;
  let axiosMock: MockAdapter;
  let calendarManager: any;

  beforeEach(() => {
    // Create isolated test environment
    const testEnv = createIsolatedTestEnvironment();
    calendarManager = testEnv.calendarManager;

    // Setup axios mock
    axiosMock = new MockAdapter(axios);

    // Create server with isolated calendar manager
    server = setupServer(calendarManager);
  });

  afterEach(async () => {
    // Restore axios
    axiosMock.restore();

    // Clean up isolated test environment
    await cleanupIsolatedTestEnvironment(calendarManager);
  });

  describe("Tool: subscribe_calendar", () => {
    it("should successfully subscribe to a calendar", async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: {
            url: mockUrl,
            name: "Test Calendar",
            refreshInterval: 30,
          },
        },
      });

      expect(response.content[0].text).toContain("Successfully subscribed");
      expect(response.content[0].text).toContain("Test Calendar");
      expect(response.content[0].text).toContain("30 minutes");
    });

    it("should handle invalid URLs", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: {
            url: "not-a-url",
            name: "Test Calendar",
          },
        },
      });

      expect(response.content[0].text).toContain("Error");
      expect(response.content[0].text).toContain("Invalid URL");
    });

    it("should prevent duplicate calendar names", async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");

      // First subscription
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });

      // Attempt duplicate
      const response = await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });

      expect(response.content[0].text).toContain("Error");
      expect(response.content[0].text).toContain("already exists");
    });
  });

  describe("Tool: list_calendars", () => {
    it("should return empty list when no calendars", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "list_calendars",
          arguments: {},
        },
      });

      expect(response.content[0].text).toBe("No calendars subscribed");
    });

    it("should list subscribed calendars", async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");

      // Subscribe first
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });

      // List calendars
      const response = await handler({
        method: "tools/call",
        params: {
          name: "list_calendars",
          arguments: {},
        },
      });

      expect(response.content[0].text).toContain("Test Calendar");
      expect(response.content[0].text).toContain(mockUrl);
    });
  });

  describe("Tool: unsubscribe_calendar", () => {
    it("should unsubscribe from existing calendar", async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");

      // Subscribe first
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });

      // Unsubscribe
      const response = await handler({
        method: "tools/call",
        params: {
          name: "unsubscribe_calendar",
          arguments: { name: "Test Calendar" },
        },
      });

      expect(response.content[0].text).toContain("Successfully unsubscribed");
      expect(response.content[0].text).toContain("Test Calendar");
    });

    it("should error on non-existent calendar", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "unsubscribe_calendar",
          arguments: { name: "Non-existent" },
        },
      });

      expect(response.content[0].text).toContain("Error");
      expect(response.content[0].text).toContain("not found");
    });
  });

  describe("Tool: get_events", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });
    });

    it("should return events in date range", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_events",
          arguments: {
            startDate: "2025-08-14",
            endDate: "2025-08-17",
            calendarName: "Test Calendar",
          },
        },
      });

      const events = JSON.parse(response.content[0].text);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]).toHaveProperty("summary");
      expect(events[0]).toHaveProperty("start");
    });

    it("should respect limit parameter", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_events",
          arguments: {
            startDate: "2025-08-01",
            endDate: "2025-08-31",
            limit: 1,
          },
        },
      });

      const events = JSON.parse(response.content[0].text);
      expect(events.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Tool: search_events", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });
    });

    it("should find events by query", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "search_events",
          arguments: {
            query: "meeting",
            calendarName: "Test Calendar",
          },
        },
      });

      const events = JSON.parse(response.content[0].text);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      expect(
        events.every(
          (e: any) =>
            e.summary.toLowerCase().includes("meeting") ||
            e.description?.toLowerCase().includes("meeting"),
        ),
      ).toBe(true);
    });

    it("should support date range filtering", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "search_events",
          arguments: {
            query: "test",
            startDate: "2025-08-15",
            endDate: "2025-08-16",
          },
        },
      });

      const events = JSON.parse(response.content[0].text);
      expect(
        events.every((e: any) => {
          const eventStart = Temporal.ZonedDateTime.from(e.start);
          const rangeStart = Temporal.PlainDate.from(
            "2025-08-15",
          ).toZonedDateTime({
            plainTime: "00:00:00",
            timeZone: eventStart.timeZoneId,
          });
          const rangeEnd = Temporal.PlainDate.from(
            "2025-08-16",
          ).toZonedDateTime({
            plainTime: "23:59:59",
            timeZone: eventStart.timeZoneId,
          });
          return (
            Temporal.ZonedDateTime.compare(eventStart, rangeStart) >= 0 &&
            Temporal.ZonedDateTime.compare(eventStart, rangeEnd) <= 0
          );
        }),
      ).toBe(true);
    });
  });

  describe("Tool: get_upcoming_events", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, mockCalendarData);

      const handler = server.getRequestHandlers().get("tools/call");
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Test Calendar" },
        },
      });
    });

    it("should return upcoming events", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_upcoming_events",
          arguments: {
            days: 30,
            calendarName: "Test Calendar",
          },
        },
      });

      const events = JSON.parse(response.content[0].text);
      expect(Array.isArray(events)).toBe(true);
    });

    it("should respect days and limit parameters", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_upcoming_events",
          arguments: {
            days: 7,
            limit: 2,
          },
        },
      });

      const events = JSON.parse(response.content[0].text);
      expect(events.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Tool: list_tools", () => {
    it("should list all available tools", async () => {
      const handler = server.getRequestHandlers().get("tools/list");
      const response = await handler({
        method: "tools/list",
      });

      expect(response.tools).toBeDefined();
      expect(response.tools.length).toBe(7);

      const toolNames = response.tools.map((t: any) => t.name);
      expect(toolNames).toContain("subscribe_calendar");
      expect(toolNames).toContain("list_calendars");
      expect(toolNames).toContain("unsubscribe_calendar");
      expect(toolNames).toContain("get_events");
      expect(toolNames).toContain("search_events");
      expect(toolNames).toContain("get_upcoming_events");
      expect(toolNames).toContain("get_daily_agenda");
    });
  });
});

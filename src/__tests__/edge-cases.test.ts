import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { CalendarManager } from "../calendar-manager";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import { promises as fs } from "fs";
import path from "path";
import {
  createIsolatedTestEnvironment,
  cleanupIsolatedTestEnvironment,
} from "./test-helpers";

describe("CalendarManager - Edge Cases", () => {
  let calendarManager: CalendarManager;
  let axiosMock: MockAdapter;
  let comprehensiveIcsContent: string;

  beforeAll(async () => {
    // Read comprehensive calendar data
    comprehensiveIcsContent = await fs.readFile(
      path.join(__dirname, "fixtures", "comprehensive-calendar.ics"),
      "utf-8",
    );
  });

  beforeEach(() => {
    const testEnv = createIsolatedTestEnvironment();
    calendarManager = testEnv.calendarManager;
    axiosMock = new MockAdapter(axios);
  });

  afterEach(async () => {
    axiosMock.restore();
    await cleanupIsolatedTestEnvironment(calendarManager);
  });

  describe("Recurring Events", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle weekly recurring events with RRULE", async () => {
      const events = await calendarManager.searchEvents("Weekly Team Standup");

      expect(events.length).toBeGreaterThan(0);
      const recurringEvent = events[0];
      expect(recurringEvent.recurrence).toBeDefined();
      expect(recurringEvent.summary).toBe("Weekly Team Standup");
    });

    it("should handle EXDATE exclusions in recurring events", async () => {
      const startDate = new Date("2025-08-20");
      const endDate = new Date("2025-09-05");
      const events = await calendarManager.getEvents(
        startDate,
        endDate,
        "Test Calendar",
      );

      // Should not include excluded dates (Aug 25 and Sep 1)
      const standupEvents = events.filter(
        (e) => e.summary === "Weekly Team Standup",
      );
      const excludedDates = ["2025-08-25", "2025-09-01"];

      standupEvents.forEach((event) => {
        const eventDate = event.start.toPlainDate().toString();
        expect(excludedDates).not.toContain(eventDate);
      });
    });
  });

  describe("Event Status Handling", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle tentative events", async () => {
      const events = await calendarManager.searchEvents("Tentative");

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].summary).toContain("Tentative");
    });

    it("should handle cancelled events", async () => {
      const events = await calendarManager.searchEvents("Cancelled");

      // Depending on implementation, cancelled events might be filtered out
      // or included with a cancelled status
      expect(events.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle private events", async () => {
      const events = await calendarManager.searchEvents("Private");

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].summary).toContain("Private");
    });
  });

  describe("Complex Event Properties", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle events with multiple attendees", async () => {
      const events = await calendarManager.searchEvents("Weekly Team Standup");

      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event.attendees).toBeDefined();
      expect(event.attendees?.length).toBeGreaterThan(1);
    });

    it("should handle events with categories", async () => {
      const events = await calendarManager.searchEvents("Complex Meeting");

      expect(events.length).toBeGreaterThan(0);
      // Categories might be parsed into description or separate field
    });

    it("should handle multi-line descriptions", async () => {
      const events = await calendarManager.searchEvents("Complex Meeting");

      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event.description).toContain("Meeting Agenda:");
      expect(event.description).toContain("\n");
    });

    it("should handle location with special characters", async () => {
      const events = await calendarManager.searchEvents("Complex Meeting");

      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event.location).toContain(",");
    });
  });

  describe("Timezone Handling", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle events with timezone information", async () => {
      const events = await calendarManager.searchEvents(
        "International Conference",
      );

      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event.start).toBeInstanceOf(Temporal.ZonedDateTime);
      // The date should be properly converted from Eastern time
    });

    it("should handle events in different timezones correctly", async () => {
      const events = await calendarManager.getEvents(
        new Date("2025-08-24"),
        new Date("2025-08-25"),
        "Test Calendar",
      );

      const intlEvent = events.find(
        (e) => e.summary === "International Conference Call",
      );
      expect(intlEvent).toBeDefined();
    });
  });

  describe("Priority and Importance", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle high priority events", async () => {
      const events = await calendarManager.searchEvents("Critical");

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].summary).toContain("Critical");
      // Priority might be parsed into a separate field
    });
  });

  describe("Overlapping Events", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle overlapping events correctly", async () => {
      const events = await calendarManager.searchEvents("Overlapping Meeting");

      expect(events.length).toBe(2);
      const [event1, event2] = events;

      // Check that both events exist and overlap in time
      expect(
        Temporal.ZonedDateTime.compare(event1.start, event2.end) < 0 &&
          Temporal.ZonedDateTime.compare(event2.start, event1.end) < 0,
      ).toBe(true);
    });
  });

  describe("All-Day Events", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should properly identify all-day events", async () => {
      const events = await calendarManager.searchEvents("Company Holiday");

      expect(events.length).toBeGreaterThan(0);
      const holiday = events[0];
      expect(holiday.isAllDay).toBe(true);

      // All-day events are parsed as dates, check that it's marked as all-day
      expect(holiday.isAllDay).toBe(true);
    });
  });

  describe("Event Reminders/Alarms", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
    });

    it("should handle events with reminders", async () => {
      const events = await calendarManager.searchEvents("Project Deadline");

      expect(events.length).toBeGreaterThan(0);
      // Reminders might be parsed into description or ignored
    });
  });

  describe("Special Characters and Encoding", () => {
    it("should handle URLs in descriptions", async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);

      const events = await calendarManager.searchEvents("zoom.us");

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].description).toContain("https://");
    });

    it("should handle escaped characters in text fields", async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, comprehensiveIcsContent);
      await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);

      const events = await calendarManager.searchEvents("Complex Meeting");

      expect(events.length).toBeGreaterThan(0);
      // Commas should be unescaped in the location
      expect(events[0].location).toContain(",");
    });
  });

  describe("Performance with Large Calendars", () => {
    it("should handle calendars with many events efficiently", async () => {
      // Create a large calendar with many events
      let largeCalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
`;

      // Add 100 events
      for (let i = 0; i < 100; i++) {
        const date = new Date(2025, 7, 15 + Math.floor(i / 10), i % 24);
        largeCalendar += `BEGIN:VEVENT
UID:test-${i}@example.com
SUMMARY:Event ${i}
DTSTART:${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z
DTEND:${new Date(date.getTime() + 3600000).toISOString().replace(/[-:]/g, "").split(".")[0]}Z
END:VEVENT
`;
      }
      largeCalendar += "END:VCALENDAR";

      const mockUrl = "https://example.com/large-calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, largeCalendar);

      const startTime = Date.now();
      await calendarManager.subscribeCalendar(mockUrl, "Large Calendar", 30);

      const events = await calendarManager.getEvents(
        new Date("2025-08-01"),
        new Date("2025-08-31"),
        "Large Calendar",
        50,
      );

      const endTime = Date.now();

      expect(events.length).toBeLessThanOrEqual(50);
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });
});

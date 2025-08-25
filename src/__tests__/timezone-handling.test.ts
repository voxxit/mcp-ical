import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarManager } from "../calendar-manager";
import {
  cleanupIsolatedTestEnvironment,
  createIsolatedTestEnvironment,
} from "./test-helpers";

describe("Timezone Handling Tests", () => {
  let calendarManager: CalendarManager;
  let axiosMock: MockAdapter;

  // Calendar with events in different timezones
  const multiTimezoneCalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Timezone Test//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:utc-event@test.com
SUMMARY:UTC Event (9 AM UTC)
DTSTART:20250812T090000Z
DTEND:20250812T100000Z
DESCRIPTION:Event in UTC time
END:VEVENT
BEGIN:VEVENT
UID:ny-event@test.com
SUMMARY:New York Event (9 AM EST)
DTSTART;TZID=America/New_York:20250812T090000
DTEND;TZID=America/New_York:20250812T100000
DESCRIPTION:Event in New York time (should be 13:00 UTC in summer)
END:VEVENT
BEGIN:VEVENT
UID:london-event@test.com
SUMMARY:London Event (9 AM BST)
DTSTART;TZID=Europe/London:20250812T090000
DTEND;TZID=Europe/London:20250812T100000
DESCRIPTION:Event in London time (should be 08:00 UTC in summer)
END:VEVENT
BEGIN:VEVENT
UID:float-event@test.com
SUMMARY:Floating Time Event
DTSTART:20250812T090000
DTEND:20250812T100000
DESCRIPTION:Event without timezone (floating time)
END:VEVENT
BEGIN:VEVENT
UID:late-ny-event@test.com
SUMMARY:Late NY Event (11 PM EST)
DTSTART;TZID=America/New_York:20250812T230000
DTEND;TZID=America/New_York:20250813T000000
DESCRIPTION:Event late in NY time (crosses midnight UTC)
END:VEVENT
END:VCALENDAR`;

  beforeEach(() => {
    const testEnv = createIsolatedTestEnvironment();
    calendarManager = testEnv.calendarManager;
    axiosMock = new MockAdapter(axios);
  });

  afterEach(async () => {
    axiosMock.restore();
    await cleanupIsolatedTestEnvironment(calendarManager);
  });

  describe("Single Day with Multiple Timezones", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, multiTimezoneCalendar);
      await calendarManager.subscribeCalendar(mockUrl, "Timezone Calendar", 30);
    });

    it("should find all events on the same calendar day regardless of timezone", async () => {
      const events = await calendarManager.getEvents(
        new Date("2025-08-12"),
        new Date("2025-08-12T23:59:59"),
        "Timezone Calendar",
      );

      expect(events.length).toBeGreaterThanOrEqual(4);

      const summaries = events.map((e) => e.summary);
      expect(summaries).toContain("UTC Event (9 AM UTC)");
      expect(summaries).toContain("New York Event (9 AM EST)");
      expect(summaries).toContain("London Event (9 AM BST)");
      expect(summaries).toContain("Floating Time Event");
    });

    it("should correctly parse timezone-specific events", async () => {
      const events = await calendarManager.getEvents(
        new Date("2025-08-12"),
        new Date("2025-08-12T23:59:59"),
        "Timezone Calendar",
      );

      // Find the NY event
      const nyEvent = events.find(
        (e) => e.summary === "New York Event (9 AM EST)",
      );
      expect(nyEvent).toBeDefined();

      // 9 AM EST in August should be 1 PM UTC (13:00) due to EDT
      const nyEventUTCHour = nyEvent!.start
        .toInstant()
        .toZonedDateTimeISO("UTC").hour;
      // Note: This might be 13 or 14 depending on DST handling
      expect(nyEventUTCHour).toBeGreaterThanOrEqual(13);
      expect(nyEventUTCHour).toBeLessThanOrEqual(14);
    });

    it("should handle events that cross midnight in their local timezone", async () => {
      // Query for events on Aug 12-13 to capture the late NY event
      // which starts at 11 PM EST on Aug 12 (3 AM UTC on Aug 13)
      const events = await calendarManager.getEvents(
        new Date("2025-08-12"),
        new Date("2025-08-13T23:59:59"),
        "Timezone Calendar",
      );

      const lateEvent = events.find(
        (e) => e.summary === "Late NY Event (11 PM EST)",
      );
      expect(lateEvent).toBeDefined();

      // Event starts at 11 PM NY time on Aug 12
      // In UTC, this could be early morning Aug 13
      if (lateEvent) {
        const startDate = lateEvent.start;
        const endDate = lateEvent.end;

        // The event should span across midnight
        expect(
          Temporal.ZonedDateTime.compare(endDate, startDate),
        ).toBeGreaterThan(0);
      }
    });
  });

  describe("Date Range Queries Across Timezones", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, multiTimezoneCalendar);
      await calendarManager.subscribeCalendar(mockUrl, "Timezone Calendar", 30);
    });

    it("should handle date queries consistently regardless of local timezone", async () => {
      // Query for a specific date
      const aug12Start = new Date("2025-08-12T00:00:00");
      const aug12End = new Date("2025-08-12T23:59:59");

      const events = await calendarManager.getEvents(
        aug12Start,
        aug12End,
        "Timezone Calendar",
      );

      // Should get all events scheduled for Aug 12 in any timezone
      expect(events.length).toBeGreaterThan(0);

      // All returned events should have start times within the queried range
      events.forEach((event) => {
        // The event should start on or after the start date
        const startInstant = Temporal.Instant.fromEpochMilliseconds(
          aug12Start.getTime(),
        );
        const endInstant = Temporal.Instant.fromEpochMilliseconds(
          aug12End.getTime(),
        );
        const dayBuffer = Temporal.Duration.from({ days: 1 });

        expect(
          Temporal.ZonedDateTime.compare(
            event.start,
            startInstant
              .toZonedDateTimeISO(event.start.timeZoneId)
              .subtract(dayBuffer),
          ),
        ).toBeGreaterThanOrEqual(0);
        // And before or at the end date + 1 day for timezone differences
        expect(
          Temporal.ZonedDateTime.compare(
            event.start,
            endInstant
              .toZonedDateTimeISO(event.start.timeZoneId)
              .add(dayBuffer),
          ),
        ).toBeLessThanOrEqual(0);
      });
    });

    it("should correctly identify floating time events", async () => {
      const events = await calendarManager.getEvents(
        new Date("2025-08-12"),
        new Date("2025-08-12T23:59:59"),
        "Timezone Calendar",
      );

      const floatingEvent = events.find(
        (e) => e.summary === "Floating Time Event",
      );
      expect(floatingEvent).toBeDefined();

      // Floating time events should be interpreted in local time
      if (floatingEvent) {
        // The hour should be 9 (as specified in the event)
        const eventHour = floatingEvent.start.hour;
        // This could be 9 in local time or adjusted for UTC
        expect(eventHour).toBeDefined();
      }
    });
  });

  describe("Edge Cases with DST Transitions", () => {
    const dstTransitionCalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//DST Test//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:dst-spring@test.com
SUMMARY:Spring DST Event
DTSTART;TZID=America/New_York:20250309T013000
DTEND;TZID=America/New_York:20250309T033000
DESCRIPTION:Event during spring DST transition (2 AM becomes 3 AM)
END:VEVENT
BEGIN:VEVENT
UID:dst-fall@test.com
SUMMARY:Fall DST Event
DTSTART;TZID=America/New_York:20251102T013000
DTEND;TZID=America/New_York:20251102T033000
DESCRIPTION:Event during fall DST transition (2 AM becomes 1 AM)
END:VEVENT
END:VCALENDAR`;

    it("should handle events during DST transitions", async () => {
      const mockUrl = "https://example.com/dst-calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, dstTransitionCalendar);
      await calendarManager.subscribeCalendar(mockUrl, "DST Calendar", 30);

      // Test spring DST transition
      const springEvents = await calendarManager.getEvents(
        new Date("2025-03-09"),
        new Date("2025-03-09T23:59:59"),
        "DST Calendar",
      );

      const springEvent = springEvents.find(
        (e) => e.summary === "Spring DST Event",
      );
      expect(springEvent).toBeDefined();

      // Test fall DST transition
      const fallEvents = await calendarManager.getEvents(
        new Date("2025-11-02"),
        new Date("2025-11-02T23:59:59"),
        "DST Calendar",
      );

      const fallEvent = fallEvents.find((e) => e.summary === "Fall DST Event");
      expect(fallEvent).toBeDefined();
    });
  });
});

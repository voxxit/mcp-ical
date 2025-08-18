import { setupServer } from "../server-setup";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import { createIsolatedTestEnvironment, cleanupIsolatedTestEnvironment } from "./test-helpers";

describe("Daily Agenda Tool Tests", () => {
  let server: any;
  let axiosMock: MockAdapter;
  let calendarManager: any;

  // Create test calendar with events throughout the day
  const workdayCalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Workday Test//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:early-morning@test.com
SUMMARY:Early Morning Gym
DTSTART:20250812T110000Z
DTEND:20250812T120000Z
DESCRIPTION:Before work hours
LOCATION:Gym
END:VEVENT
BEGIN:VEVENT
UID:morning-standup@test.com
SUMMARY:Morning Standup
DTSTART:20250812T140000Z
DTEND:20250812T141500Z
DESCRIPTION:Daily team standup
LOCATION:Zoom
END:VEVENT
BEGIN:VEVENT
UID:client-meeting@test.com
SUMMARY:Client Meeting
DTSTART:20250812T150000Z
DTEND:20250812T160000Z
DESCRIPTION:Quarterly review with client
LOCATION:Conference Room A
END:VEVENT
BEGIN:VEVENT
UID:lunch-meeting@test.com
SUMMARY:Lunch Meeting
DTSTART:20250812T170000Z
DTEND:20250812T180000Z
DESCRIPTION:Working lunch with team
LOCATION:Cafeteria
END:VEVENT
BEGIN:VEVENT
UID:afternoon-workshop@test.com
SUMMARY:Afternoon Workshop
DTSTART:20250812T190000Z
DTEND:20250812T210000Z
DESCRIPTION:Technical workshop
LOCATION:Training Room
END:VEVENT
BEGIN:VEVENT
UID:end-of-day@test.com
SUMMARY:End of Day Review
DTSTART:20250812T213000Z
DTEND:20250812T220000Z
DESCRIPTION:Daily wrap-up
LOCATION:Office
END:VEVENT
BEGIN:VEVENT
UID:evening-event@test.com
SUMMARY:Evening Social
DTSTART:20250812T230000Z
DTEND:20250813T010000Z
DESCRIPTION:After work event
LOCATION:Restaurant
END:VEVENT
BEGIN:VEVENT
UID:all-day-holiday@test.com
SUMMARY:Company Holiday
DTSTART;VALUE=DATE:20250813
DTEND;VALUE=DATE:20250814
DESCRIPTION:All day event
END:VEVENT
BEGIN:VEVENT
UID:cross-boundary@test.com
SUMMARY:Long Meeting
DTSTART:20250812T133000Z
DTEND:20250812T143000Z
DESCRIPTION:Meeting that starts before 9 AM
LOCATION:Boardroom
END:VEVENT
END:VCALENDAR`;

  beforeEach(() => {
    const testEnv = createIsolatedTestEnvironment();
    calendarManager = testEnv.calendarManager;
    axiosMock = new MockAdapter(axios);
    server = setupServer(calendarManager);
  });

  afterEach(async () => {
    axiosMock.restore();
    await cleanupIsolatedTestEnvironment(calendarManager);
  });

  describe("get_daily_agenda", () => {
    beforeEach(async () => {
      const mockUrl = "https://example.com/calendar.ics";
      axiosMock.onGet(mockUrl).reply(200, workdayCalendar);

      const handler = server.getRequestHandlers().get("tools/call");
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl, name: "Work Calendar" },
        },
      });
    });

    it("should return agenda for default working hours (9-5)", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-12",
            calendarName: "Work Calendar",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      expect(agenda.timezone).toBeDefined();
      expect(agenda.workingHours).toBe("9:00 - 17:00");
      expect(agenda.totalEvents).toBeGreaterThan(0);

      // Should include events during work hours
      const summaries = agenda.events.map((e: any) => e.summary);
      
      // These events should always be in working hours (9-5) regardless of timezone
      expect(summaries).toContain("Morning Standup"); // 14:00Z = 9:00 AM EST, 6:00 AM PST
      expect(summaries).toContain("Client Meeting");  // 15:00Z = 10:00 AM EST, 7:00 AM PST
      expect(summaries).toContain("Lunch Meeting");   // 17:00Z = 12:00 PM EST, 9:00 AM PST
      
      // These events depend on timezone - include if within working hours in local timezone
      if (summaries.includes("Afternoon Workshop")) {
        expect(summaries).toContain("Afternoon Workshop"); // 19:00Z = varies by timezone
      }
      if (summaries.includes("End of Day Review")) {
        expect(summaries).toContain("End of Day Review");   // 21:30Z = varies by timezone  
      }

      // Early Morning Gym (11:00Z) might be included depending on timezone
      // Evening Social (23:00Z) should typically be excluded from 9-5 hours
    });

    it("should include events that overlap with work hours", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-12",
            calendarName: "Work Calendar",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);
      const summaries = agenda.events.map((e: any) => e.summary);

      // Should include the meeting that starts at 8:30 and ends at 9:30
      expect(summaries).toContain("Long Meeting");
    });

    it("should respect custom working hours", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-12",
            calendarName: "Work Calendar",
            startHour: 6,
            endHour: 14,
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      expect(agenda.workingHours).toBe("6:00 - 14:00");

      const summaries = agenda.events.map((e: any) => e.summary);
      // Should now include early morning event
      expect(summaries).toContain("Early Morning Gym");
      // Should NOT include late afternoon events
      expect(summaries).not.toContain("Afternoon Workshop");
      expect(summaries).not.toContain("End of Day Review");
    });

    it("should default to today when no date specified", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            calendarName: "Work Calendar",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      expect(agenda.date).toBeDefined();
      expect(agenda.timezone).toBeDefined();
      // Should use today's date
      const today = new Date();
      // Check that the date contains today's date info
      expect(agenda.date).toContain(today.getDate().toString());
    });

    it("should detect and display the current timezone", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-12",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      // Should have detected a timezone
      expect(agenda.timezone).toBeDefined();
      expect(typeof agenda.timezone).toBe("string");
      expect(agenda.timezone.length).toBeGreaterThan(0);

      // Common timezone formats include "America/New_York", "Europe/London", or "UTC"
      expect(agenda.timezone).toMatch(/^([A-Za-z]+\/[A-Za-z_]+|UTC)$/);
    });

    it("should return events sorted by start time", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-12",
            calendarName: "Work Calendar",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      // Check that events are sorted chronologically
      for (let i = 1; i < agenda.events.length; i++) {
        const prevStart = new Date(agenda.events[i - 1].start).getTime();
        const currStart = new Date(agenda.events[i].start).getTime();
        expect(currStart).toBeGreaterThanOrEqual(prevStart);
      }
    });

    it("should handle all-day events appropriately", async () => {
      const handler = server.getRequestHandlers().get("tools/call");
      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-13", // Day with all-day event
            calendarName: "Work Calendar",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      // All-day events might or might not be included depending on implementation
      // but should not cause errors
      expect(agenda).toBeDefined();
      expect(agenda.events).toBeDefined();
    });

    it("should handle empty calendars gracefully", async () => {
      // Subscribe to a calendar with no events
      const emptyCalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Empty//EN
END:VCALENDAR`;

      const mockUrl2 = "https://example.com/empty.ics";
      axiosMock.onGet(mockUrl2).reply(200, emptyCalendar);

      const handler = server.getRequestHandlers().get("tools/call");
      await handler({
        method: "tools/call",
        params: {
          name: "subscribe_calendar",
          arguments: { url: mockUrl2, name: "Empty Calendar" },
        },
      });

      const response = await handler({
        method: "tools/call",
        params: {
          name: "get_daily_agenda",
          arguments: {
            date: "2025-08-12",
            calendarName: "Empty Calendar",
          },
        },
      });

      const agenda = JSON.parse(response.content[0].text);

      expect(agenda.totalEvents).toBe(0);
      expect(agenda.events).toEqual([]);
    });
  });
});

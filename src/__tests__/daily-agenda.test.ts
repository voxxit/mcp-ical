import { setupServer } from "../server-setup";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import { promises as fs } from "fs";
import path from "path";

describe("Daily Agenda Tool Tests", () => {
  let server: any;
  let axiosMock: MockAdapter;
  const testConfigPath = path.join(process.env.HOME || "", ".ical-mcp-config.json");
  const originalConfigPath = testConfigPath + ".backup";

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

  beforeAll(async () => {
    try {
      await fs.rename(testConfigPath, originalConfigPath);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  });

  beforeEach(() => {
    axiosMock = new MockAdapter(axios);
    server = setupServer();
  });

  afterEach(async () => {
    axiosMock.restore();
    
    try {
      await fs.unlink(testConfigPath);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  });

  afterAll(async () => {
    try {
      await fs.rename(originalConfigPath, testConfigPath);
    } catch (error) {
      // No backup to restore, that's fine
    }
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
      expect(summaries).toContain("Morning Standup");
      expect(summaries).toContain("Client Meeting");
      expect(summaries).toContain("Lunch Meeting");
      expect(summaries).toContain("Afternoon Workshop");
      expect(summaries).toContain("End of Day Review");
      
      // Should NOT include events outside work hours
      expect(summaries).not.toContain("Early Morning Gym");
      expect(summaries).not.toContain("Evening Social");
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
      
      // Common timezone formats include "America/New_York", "Europe/London", etc.
      expect(agenda.timezone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
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
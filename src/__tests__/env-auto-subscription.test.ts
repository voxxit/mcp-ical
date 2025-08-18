import { CalendarManager } from "../calendar-manager";
import { setupServer } from "../server-setup";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import {
  createIsolatedTestEnvironment,
  cleanupIsolatedTestEnvironment,
} from "./test-helpers";

describe("Environment Variable Auto-subscription", () => {
  let calendarManager: CalendarManager;
  let axiosMock: MockAdapter;

  beforeEach(async () => {
    // Create isolated test environment
    const testEnv = createIsolatedTestEnvironment();
    calendarManager = testEnv.calendarManager;

    // Setup axios mock
    axiosMock = new MockAdapter(axios);
  });

  afterEach(async () => {
    // Restore axios
    axiosMock.restore();

    // Clean up isolated test environment
    await cleanupIsolatedTestEnvironment(calendarManager);
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

    axiosMock
      .onGet("https://example.com/env-calendar.ics")
      .reply(200, mockCalendarData);

    // Simulate the index.ts flow
    // 1. Use isolated CalendarManager instance

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

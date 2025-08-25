import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { promises as fs } from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarManager } from "../calendar-manager";
import { setupServer } from "../server-setup";
import {
	cleanupIsolatedTestEnvironment,
	createIsolatedTestEnvironment,
} from "./test-helpers";

describe("Auto-subscription functionality", () => {
	let calendarManager: CalendarManager;
	let server: Server;
	let axiosMock: MockAdapter;

	beforeEach(async () => {
		// Create isolated test environment
		const testEnv = createIsolatedTestEnvironment();
		calendarManager = testEnv.calendarManager;
		server = setupServer(calendarManager);

		// Setup axios mock
		axiosMock = new MockAdapter(axios);
	});

	afterEach(async () => {
		// Restore axios
		axiosMock.restore();

		// Clean up isolated test environment
		await cleanupIsolatedTestEnvironment(calendarManager);
	});

	it("should use the same CalendarManager instance for auto-subscription and server tools", async () => {
		// Mock the calendar URL
		const mockCalendarData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event-1
SUMMARY:Test Event
DTSTART:20250115T100000Z
DTEND:20250115T110000Z
END:VEVENT
END:VCALENDAR`;

		axiosMock
			.onGet("https://example.com/calendar.ics")
			.reply(200, mockCalendarData);

		// Simulate auto-subscription (as done in index.ts)
		await calendarManager.subscribeCalendar(
			"https://example.com/calendar.ics",
			"Auto Calendar",
			60,
		);

		// Verify calendar is subscribed
		const calendars = calendarManager.listCalendars();
		expect(calendars).toHaveLength(1);
		expect(calendars[0].name).toBe("Auto Calendar");

		// Now test that server tools see the same calendar
		const handlers = (server as any).getRequestHandlers();
		const callToolHandler = handlers.get("tools/call");

		// Call list_calendars tool
		const listResponse = await callToolHandler({
			params: {
				name: "list_calendars",
				arguments: {},
			},
		});

		// Verify the tool sees the auto-subscribed calendar
		expect(listResponse.content[0].text).toContain("Auto Calendar");
		expect(listResponse.content[0].text).toContain(
			"https://example.com/calendar.ics",
		);
	});

	it("should allow server tools to access events from auto-subscribed calendar", async () => {
		// Mock the calendar URL with events
		const mockCalendarData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:auto-event-1
SUMMARY:Auto-subscribed Event
DTSTART:20250115T140000Z
DTEND:20250115T150000Z
END:VEVENT
END:VCALENDAR`;

		axiosMock
			.onGet("https://example.com/auto-calendar.ics")
			.reply(200, mockCalendarData);

		// Simulate auto-subscription
		await calendarManager.subscribeCalendar(
			"https://example.com/auto-calendar.ics",
			"Auto Test Calendar",
			60,
		);

		// Get events using the server tool
		const handlers = (server as any).getRequestHandlers();
		const callToolHandler = handlers.get("tools/call");

		const eventsResponse = await callToolHandler({
			params: {
				name: "get_events",
				arguments: {
					startDate: "2025-01-15",
					endDate: "2025-01-15",
					calendarName: "Auto Test Calendar",
				},
			},
		});

		const events = JSON.parse(eventsResponse.content[0].text);
		expect(events).toHaveLength(1);
		expect(events[0].summary).toBe("Auto-subscribed Event");
		expect(events[0].calendarName).toBe("Auto Test Calendar");
	});

	it("should persist auto-subscribed calendars for server tools", async () => {
		// Mock the calendar URL
		const mockCalendarData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:persist-event-1
SUMMARY:Persistent Event
DTSTART:20250116T100000Z
DTEND:20250116T110000Z
END:VEVENT
END:VCALENDAR`;

		axiosMock
			.onGet("https://example.com/persist.ics")
			.reply(200, mockCalendarData);

		// Simulate auto-subscription
		await calendarManager.subscribeCalendar(
			"https://example.com/persist.ics",
			"Persistent Calendar",
			60,
		);

		// Verify it's saved to disk
		const configPath = (calendarManager as any).configPath;
		const configData = await fs.readFile(configPath, "utf-8");
		const config = JSON.parse(configData);
		expect(config["Persistent Calendar"]).toBeDefined();
		expect(config["Persistent Calendar"].url).toBe(
			"https://example.com/persist.ics",
		);

		// Create a new CalendarManager and server using the same config (simulating restart)
		const newCalendarManager = new CalendarManager(configPath);
		const newServer = setupServer(newCalendarManager);

		// The new instance should have loaded the persisted calendar
		const calendars = newCalendarManager.listCalendars();
		expect(calendars).toHaveLength(1);
		expect(calendars[0].name).toBe("Persistent Calendar");

		// Verify server tools can access it
		const handlers = (newServer as any).getRequestHandlers();
		const callToolHandler = handlers.get("tools/call");

		const eventsResponse = await callToolHandler({
			params: {
				name: "get_events",
				arguments: {
					startDate: "2025-01-16",
					endDate: "2025-01-16",
				},
			},
		});

		const events = JSON.parse(eventsResponse.content[0].text);
		expect(events).toHaveLength(1);
		expect(events[0].summary).toBe("Persistent Event");
	});
});

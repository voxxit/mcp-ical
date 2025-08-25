import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { promises as fs } from "fs";
import path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CalendarManager } from "../calendar-manager";
import {
	cleanupIsolatedTestEnvironment,
	createIsolatedTestEnvironment,
} from "./test-helpers";

describe("CalendarManager", () => {
	let calendarManager: CalendarManager;
	let axiosMock: MockAdapter;
	let mockIcsContent: string;

	beforeAll(async () => {
		// Read mock calendar data
		mockIcsContent = await fs.readFile(
			path.join(__dirname, "fixtures", "mock-calendar.ics"),
			"utf-8",
		);
	});

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

	describe("subscribe_calendar", () => {
		it("should successfully subscribe to a calendar", async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);

			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);

			const calendars = calendarManager.listCalendars();
			expect(calendars).toHaveLength(1);
			expect(calendars[0]).toMatchObject({
				url: mockUrl,
				name: "Test Calendar",
				refreshInterval: 30,
			});
		});

		it("should reject invalid URLs", async () => {
			await expect(
				calendarManager.subscribeCalendar("not-a-url", "Test Calendar", 30),
			).rejects.toThrow("Invalid URL format");
		});

		it("should reject duplicate calendar names", async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);

			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);

			await expect(
				calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30),
			).rejects.toThrow('Calendar "Test Calendar" already exists');
		});

		it("should handle network errors", async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).networkError();

			await expect(
				calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30),
			).rejects.toThrow("fetch: Network Error");
		});
	});

	describe("list_calendars", () => {
		it("should return empty list when no calendars subscribed", () => {
			const calendars = calendarManager.listCalendars();
			expect(calendars).toEqual([]);
		});

		it("should return list of subscribed calendars", async () => {
			const mockUrl1 = "https://example.com/calendar1.ics";
			const mockUrl2 = "https://example.com/calendar2.ics";

			axiosMock.onGet(mockUrl1).reply(200, mockIcsContent);
			axiosMock.onGet(mockUrl2).reply(200, mockIcsContent);

			await calendarManager.subscribeCalendar(mockUrl1, "Calendar 1", 30);
			await calendarManager.subscribeCalendar(mockUrl2, "Calendar 2", 60);

			const calendars = calendarManager.listCalendars();
			expect(calendars).toHaveLength(2);
			expect(calendars.map((c) => c.name)).toEqual([
				"Calendar 1",
				"Calendar 2",
			]);
		});
	});

	describe("unsubscribe_calendar", () => {
		it("should successfully unsubscribe from a calendar", async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);

			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
			expect(calendarManager.listCalendars()).toHaveLength(1);

			calendarManager.unsubscribeCalendar("Test Calendar");
			expect(calendarManager.listCalendars()).toHaveLength(0);
		});

		it("should error when calendar doesn't exist", () => {
			expect(() => {
				calendarManager.unsubscribeCalendar("Non-existent Calendar");
			}).toThrow('Calendar "Non-existent Calendar" not found');
		});
	});

	describe("get_events", () => {
		beforeEach(async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);
			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
		});

		it("should return events within date range", async () => {
			const startDate = new Date("2025-08-14");
			const endDate = new Date("2025-08-17");

			const events = await calendarManager.getEvents(
				startDate,
				endDate,
				"Test Calendar",
			);

			expect(events.length).toBeGreaterThan(0);
			expect(
				events.every(
					(e) =>
						Temporal.ZonedDateTime.compare(
							e.start,
							Temporal.Instant.fromEpochMilliseconds(
								startDate.getTime(),
							).toZonedDateTimeISO(e.start.timeZoneId),
						) >= 0 &&
						Temporal.ZonedDateTime.compare(
							e.start,
							Temporal.Instant.fromEpochMilliseconds(
								endDate.getTime(),
							).toZonedDateTimeISO(e.start.timeZoneId),
						) <= 0,
				),
			).toBe(true);
		});

		it("should respect limit parameter", async () => {
			const startDate = new Date("2025-08-01");
			const endDate = new Date("2025-09-30");

			const events = await calendarManager.getEvents(
				startDate,
				endDate,
				"Test Calendar",
				2,
			);

			expect(events.length).toBeLessThanOrEqual(2);
		});

		it("should handle all-day events", async () => {
			const startDate = new Date("2025-08-20");
			const endDate = new Date("2025-08-30");

			const events = await calendarManager.getEvents(
				startDate,
				endDate,
				"Test Calendar",
			);

			const allDayEvent = events.find((e) => e.summary === "Summer Holiday");
			expect(allDayEvent).toBeDefined();
			expect(allDayEvent?.isAllDay).toBe(true);
		});
	});

	describe("search_events", () => {
		beforeEach(async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);
			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
		});

		it("should find events by text in summary", async () => {
			const events = await calendarManager.searchEvents(
				"Meeting",
				"Test Calendar",
			);

			expect(events.length).toBeGreaterThan(0);
			// Check that at least one event matches (not all events need to match)
			expect(
				events.some((e) => e.summary.toLowerCase().includes("meeting")),
			).toBe(true);
		});

		it("should find events by text in description", async () => {
			const events = await calendarManager.searchEvents(
				"standup",
				"Test Calendar",
			);

			expect(events.length).toBeGreaterThan(0);
			expect(
				events.some((e) => e.description?.toLowerCase().includes("standup")),
			).toBe(true);
		});

		it("should respect date range filters", async () => {
			const startDate = new Date("2025-08-15");
			const endDate = new Date("2025-08-20");

			const events = await calendarManager.searchEvents(
				"Meeting",
				"Test Calendar",
				startDate,
				endDate,
			);

			expect(
				events.every(
					(e) =>
						Temporal.ZonedDateTime.compare(
							e.start,
							Temporal.Instant.fromEpochMilliseconds(
								startDate.getTime(),
							).toZonedDateTimeISO(e.start.timeZoneId),
						) >= 0 &&
						Temporal.ZonedDateTime.compare(
							e.start,
							Temporal.Instant.fromEpochMilliseconds(
								endDate.getTime(),
							).toZonedDateTimeISO(e.start.timeZoneId),
						) <= 0,
				),
			).toBe(true);
		});

		it("should be case insensitive", async () => {
			const eventsLower = await calendarManager.searchEvents(
				"meeting",
				"Test Calendar",
			);
			const eventsUpper = await calendarManager.searchEvents(
				"MEETING",
				"Test Calendar",
			);

			expect(eventsLower.length).toBe(eventsUpper.length);
		});
	});

	describe("get_upcoming_events", () => {
		beforeEach(async () => {
			const mockUrl = "https://example.com/calendar.ics";
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);
			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 30);
		});

		it("should return upcoming events for specified days", async () => {
			// Test without mocking Date to avoid issues
			const events = await calendarManager.getUpcomingEvents(
				30,
				"Test Calendar",
			);

			expect(events.length).toBeGreaterThan(0);
			// Events should be in the future
			const now = Temporal.Now.instant();
			expect(
				events.some(
					(e) =>
						Temporal.ZonedDateTime.compare(
							e.start,
							now.toZonedDateTimeISO(e.start.timeZoneId),
						) >= 0,
				),
			).toBe(true);
		});

		it("should respect limit parameter", async () => {
			const events = await calendarManager.getUpcomingEvents(
				30,
				"Test Calendar",
				2,
			);

			expect(events.length).toBeLessThanOrEqual(2);
		});

		it("should return events sorted by start date", async () => {
			const events = await calendarManager.getUpcomingEvents(
				30,
				"Test Calendar",
			);

			for (let i = 1; i < events.length; i++) {
				expect(
					Temporal.ZonedDateTime.compare(events[i].start, events[i - 1].start),
				).toBeGreaterThanOrEqual(0);
			}
		});
	});

	describe("caching", () => {
		it("should cache calendar data", async () => {
			const mockUrl = "https://example.com/calendar.ics";
			// Allow multiple calls for this test
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);

			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 60);

			// First call should fetch from network
			const firstEvents = await calendarManager.getEvents(
				new Date("2025-08-01"),
				new Date("2025-08-31"),
				"Test Calendar",
			);

			expect(firstEvents.length).toBeGreaterThan(0);

			// Second call should use cache
			const cachedEvents = await calendarManager.getEvents(
				new Date("2025-08-01"),
				new Date("2025-08-31"),
				"Test Calendar",
			);

			expect(cachedEvents.length).toBe(firstEvents.length);
			// Should have made 2 requests: one for subscribe, one for first getEvents
			// The second getEvents should use cache
			expect(axiosMock.history.get.length).toBe(2);
		});

		it("should refresh cache when expired", async () => {
			const mockUrl = "https://example.com/calendar.ics";

			// Setup mock to be called multiple times
			axiosMock.onGet(mockUrl).reply(200, mockIcsContent);

			// Subscribe with minimum refresh interval (1 minute)
			await calendarManager.subscribeCalendar(mockUrl, "Test Calendar", 1);

			// First call
			await calendarManager.getEvents(
				new Date("2025-08-01"),
				new Date("2025-08-31"),
				"Test Calendar",
			);

			// Manually clear the cache to simulate expiration
			(calendarManager as any).cache.flushAll();

			// Second call should fetch again since cache is cleared
			const events = await calendarManager.getEvents(
				new Date("2025-08-01"),
				new Date("2025-08-31"),
				"Test Calendar",
			);

			expect(events.length).toBeGreaterThan(0);
			// First call to subscribe, second call for first getEvents, third for refresh
			expect(axiosMock.history.get.length).toBe(3);
		});
	});
});

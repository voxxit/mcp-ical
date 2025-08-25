import "temporal-polyfill/global";
import type * as ical from "node-ical";

/**
 * Manages timezone-aware date operations using the Temporal API.
 * Provides proper timezone handling for calendar events and working hours.
 */
export class TimezoneDateManager {
	private userTimezone: string;

	constructor(timezone?: string) {
		// Priority: explicit argument → USER_TIMEZONE → TZ → system detection → UTC fallback
		this.userTimezone =
			timezone ||
			process.env.USER_TIMEZONE ||
			process.env.TZ ||
			Temporal.Now.timeZoneId() ||
			"UTC";
	}

	/**
	 * Gets the current user's timezone
	 */
	getTimezone(): string {
		return this.userTimezone;
	}

	/**
	 * Sets a new timezone for the manager
	 */
	setTimezone(timezone: string): void {
		this.userTimezone = timezone;
	}

	/**
	 * Creates working hours boundaries for a given date in the user's timezone
	 */
	createWorkingHours(
		date: string,
		startHour: number,
		endHour: number,
	): {
		start: Temporal.ZonedDateTime;
		end: Temporal.ZonedDateTime;
	} {
		const plainDate = Temporal.PlainDate.from(date);

		const start = plainDate.toZonedDateTime({
			plainTime: `${startHour.toString().padStart(2, "0")}:00:00`,
			timeZone: this.userTimezone,
		});

		const end = plainDate.toZonedDateTime({
			plainTime: `${endHour.toString().padStart(2, "0")}:00:00`,
			timeZone: this.userTimezone,
		});

		return { start, end };
	}

	/**
	 * Parses a calendar event from node-ical into a Temporal ZonedDateTime
	 * Handles the various date formats that node-ical can return
	 */
	parseCalendarEventStart(event: ical.VEvent): Temporal.ZonedDateTime {
		if (!event.start) {
			throw new Error("Event has no start date");
		}

		// Handle native Date objects (most common case)
		if (event.start instanceof Date) {
			// Convert Date to Instant, then to ZonedDateTime in user's timezone
			const instant = Temporal.Instant.fromEpochMilliseconds(
				event.start.getTime(),
			);
			return instant.toZonedDateTimeISO(this.userTimezone);
		}

		// Handle node-ical date objects with timezone info
		if (
			typeof event.start === "object" &&
			"dateTime" in (event.start as { dateTime?: unknown })
		) {
			const dateTimeObj = event.start as { dateTime?: Date };
			if (dateTimeObj.dateTime instanceof Date) {
				const instant = Temporal.Instant.fromEpochMilliseconds(
					dateTimeObj.dateTime.getTime(),
				);
				return instant.toZonedDateTimeISO(this.userTimezone);
			}
		}

		// Handle string dates
		if (typeof event.start === "string") {
			try {
				// Try parsing as ISO string first
				const instant = Temporal.Instant.from(event.start);
				return instant.toZonedDateTimeISO(this.userTimezone);
			} catch {
				// Fall back to Date parsing
				const date = new Date(event.start);
				if (!isNaN(date.getTime())) {
					const instant = Temporal.Instant.fromEpochMilliseconds(
						date.getTime(),
					);
					return instant.toZonedDateTimeISO(this.userTimezone);
				}
			}
		}

		throw new Error(
			`Unable to parse event start date: ${JSON.stringify(event.start)}`,
		);
	}

	/**
	 * Parses a calendar event end time, with fallback to start + duration
	 */
	parseCalendarEventEnd(event: ical.VEvent): Temporal.ZonedDateTime {
		const start = this.parseCalendarEventStart(event);

		if (event.end) {
			// Same logic as start parsing
			if (event.end instanceof Date) {
				const instant = Temporal.Instant.fromEpochMilliseconds(
					event.end.getTime(),
				);
				return instant.toZonedDateTimeISO(this.userTimezone);
			}

			if (
				typeof event.end === "object" &&
				"dateTime" in (event.end as { dateTime?: unknown })
			) {
				const dateTimeObj = event.end as { dateTime?: Date };
				if (dateTimeObj.dateTime instanceof Date) {
					const instant = Temporal.Instant.fromEpochMilliseconds(
						dateTimeObj.dateTime.getTime(),
					);
					return instant.toZonedDateTimeISO(this.userTimezone);
				}
			}

			if (typeof event.end === "string") {
				try {
					const instant = Temporal.Instant.from(event.end);
					return instant.toZonedDateTimeISO(this.userTimezone);
				} catch {
					const date = new Date(event.end);
					if (!isNaN(date.getTime())) {
						const instant = Temporal.Instant.fromEpochMilliseconds(
							date.getTime(),
						);
						return instant.toZonedDateTimeISO(this.userTimezone);
					}
				}
			}
		}

		// Fallback: start + 1 hour
		return start.add({ hours: 1 });
	}

	/**
	 * Checks if an event overlaps with working hours
	 */
	eventOverlapsWorkingHours(
		event: ical.VEvent,
		date: string,
		startHour: number,
		endHour: number,
	): boolean {
		try {
			const eventStart = this.parseCalendarEventStart(event);
			const eventEnd = this.parseCalendarEventEnd(event);
			const workingHours = this.createWorkingHours(date, startHour, endHour);

			// Event overlaps if: eventStart < workEnd AND eventEnd > workStart
			return (
				Temporal.ZonedDateTime.compare(eventStart, workingHours.end) < 0 &&
				Temporal.ZonedDateTime.compare(eventEnd, workingHours.start) > 0
			);
		} catch (error) {
			console.warn("Failed to parse event for working hours check:", error);
			return false;
		}
	}

	/**
	 * Checks if a Temporal-based calendar event overlaps with working hours
	 */
	temporalEventOverlapsWorkingHours(
		eventStart: Temporal.ZonedDateTime,
		eventEnd: Temporal.ZonedDateTime,
		date: string,
		startHour: number,
		endHour: number,
	): boolean {
		try {
			const workingHours = this.createWorkingHours(date, startHour, endHour);

			// Event overlaps if: eventStart < workEnd AND eventEnd > workStart
			return (
				Temporal.ZonedDateTime.compare(eventStart, workingHours.end) < 0 &&
				Temporal.ZonedDateTime.compare(eventEnd, workingHours.start) > 0
			);
		} catch (error) {
			console.warn(
				"Failed to check temporal event for working hours overlap:",
				error,
			);
			return false;
		}
	}

	/**
	 * Formats a date for display in the user's timezone
	 */
	formatDate(
		date: Temporal.ZonedDateTime,
		options?: Intl.DateTimeFormatOptions,
	): string {
		// ZonedDateTime already has timezone info, don't specify it again
		return date.toLocaleString("en-US", options);
	}

	/**
	 * Formats a time for display in the user's timezone
	 */
	formatTime(date: Temporal.ZonedDateTime): string {
		return date.toPlainTime().toString({ smallestUnit: "minute" });
	}

	/**
	 * Checks if an event occurs on a specific date in the user's timezone
	 */
	eventOccursOnDate(event: ical.VEvent, targetDate: string): boolean {
		try {
			const eventStart = this.parseCalendarEventStart(event);
			const eventDateString = eventStart.toPlainDate().toString();
			return eventDateString === targetDate;
		} catch (error) {
			console.warn("Failed to parse event for date check:", error);
			return false;
		}
	}

	/**
	 * Creates a Temporal ZonedDateTime for "now" in the user's timezone
	 */
	now(): Temporal.ZonedDateTime {
		return Temporal.Now.zonedDateTimeISO(this.userTimezone);
	}

	/**
	 * Parses a date string (YYYY-MM-DD) into the user's timezone at start of day
	 */
	parseDate(dateString: string): Temporal.ZonedDateTime {
		const plainDate = Temporal.PlainDate.from(dateString);
		return plainDate.toZonedDateTime({
			plainTime: "00:00:00",
			timeZone: this.userTimezone,
		});
	}

	/**
	 * Gets the end of day for a given date in the user's timezone
	 */
	getEndOfDay(dateString: string): Temporal.ZonedDateTime {
		const plainDate = Temporal.PlainDate.from(dateString);
		return plainDate.toZonedDateTime({
			plainTime: "23:59:59.999",
			timeZone: this.userTimezone,
		});
	}
}

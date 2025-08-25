import { readFileSync, readlinkSync } from "fs";

export class TimezoneManager {
	private static instance: TimezoneManager;
	private timezone: string;

	private constructor() {
		// Check TZ environment variable first (UNIX standard)
		if (process.env.TZ) {
			this.timezone = process.env.TZ;
			if (process.env.NODE_ENV !== "test") {
				console.error(
					`Using timezone from TZ environment variable: ${this.timezone}`,
				);
			}
		} else {
			// Try to detect system timezone
			this.timezone = this.detectSystemTimezone();
			if (process.env.NODE_ENV !== "test") {
				console.error(`Detected system timezone: ${this.timezone}`);
			}
		}
	}

	static getInstance(): TimezoneManager {
		if (!TimezoneManager.instance) {
			TimezoneManager.instance = new TimezoneManager();
		}
		return TimezoneManager.instance;
	}

	private detectSystemTimezone(): string {
		try {
			// Method 1: Use Intl API (works in Node.js and is safe)
			const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
			if (detectedTz) {
				return detectedTz;
			}
		} catch (_error) {
			// Intl API failed
		}

		try {
			// Method 2: Check /etc/timezone (Linux) - safe file read
			const timezone = readFileSync("/etc/timezone", "utf8").trim();
			if (timezone) {
				return timezone;
			}
		} catch (_error) {
			// Not Linux or file doesn't exist
		}

		try {
			// Method 3: Check /etc/localtime symlink (Linux/Unix) - safe symlink read
			const localtime = readlinkSync("/etc/localtime");
			if (localtime) {
				// Extract timezone from path like /usr/share/zoneinfo/America/New_York
				const match = localtime.match(/zoneinfo\/(.+)$/);
				if (match) {
					return match[1];
				}
			}
		} catch (_error) {
			// Not Unix or symlink doesn't exist
		}

		// Default fallback - removed unsafe command execution methods
		console.error("Warning: Could not detect timezone, defaulting to UTC");
		return "UTC";
	}

	getTimezone(): string {
		return this.timezone;
	}

	/**
	 * Convert a date to the server's timezone
	 */
	toLocalDate(date: Date | string): Date {
		if (typeof date === "string") {
			date = new Date(date);
		}

		// If we're already in the correct timezone, return as-is
		if (this.timezone === "UTC") {
			return date;
		}

		// Create a date in the target timezone
		const localDateStr = date.toLocaleString("en-US", {
			timeZone: this.timezone,
		});
		return new Date(localDateStr);
	}

	/**
	 * Get start of day in the server's timezone
	 */
	getStartOfDay(date: Date | string): Date {
		const localDate = this.toLocalDate(date);
		const startOfDay = new Date(localDate);
		startOfDay.setHours(0, 0, 0, 0);
		return startOfDay;
	}

	/**
	 * Get end of day in the server's timezone
	 */
	getEndOfDay(date: Date | string): Date {
		const localDate = this.toLocalDate(date);
		const endOfDay = new Date(localDate);
		endOfDay.setHours(23, 59, 59, 999);
		return endOfDay;
	}

	/**
	 * Format a date in the server's timezone
	 */
	formatDate(
		date: Date | string,
		options?: Intl.DateTimeFormatOptions,
	): string {
		if (typeof date === "string") {
			date = new Date(date);
		}

		return date.toLocaleString("en-US", {
			timeZone: this.timezone,
			...options,
		});
	}

	/**
	 * Get the current date/time in the server's timezone
	 */
	getCurrentDateTime(): Date {
		return this.toLocalDate(new Date());
	}
}

import "temporal-polyfill/global";
import axios from "axios";
import { isIP } from "net";
import * as ical from "node-ical";
import { RRule, rrulestr } from "rrule";
import { SecurityConfigManager } from "./security-config.js";
import { TimezoneDateManager } from "./timezone-date-manager.js";

interface CalendarSubscription {
	url: string;
	name: string;
	refreshInterval: number; // minutes
	lastFetched?: Date;
}

interface CalendarEvent {
	id: string;
	summary: string;
	description?: string;
	start: Temporal.ZonedDateTime;
	end: Temporal.ZonedDateTime;
	location?: string;
	organizer?: string;
	attendees?: string[];
	calendarName: string;
	isAllDay: boolean;
	recurrence?: {
		rule: string;
		nextOccurrence?: Date;
	};
}

interface CalendarCache {
	url: string;
	name: string;
	refreshInterval: number;
	lastFetched: Date;
	events: CalendarEvent[];
	status: "active" | "error" | "refreshing";
	errorMessage?: string;
}

interface KVCalendarManagerOptions {
	storageKey: string;
	env: Env;
}

/**
 * Calendar Manager that uses Cloudflare KV for storage instead of filesystem
 * Provides user-specific calendar subscription management
 */
export class KVCalendarManager {
	private storageKey: string;
	private env: Env;
	private security: SecurityConfigManager;
	private timezone: TimezoneDateManager;
	
	// Simple in-memory cache for this request lifecycle
	private memoryCache = new Map<string, CalendarCache>();
	private readonly MEMORY_CACHE_TTL = 60 * 1000; // 1 minute in memory
	
	constructor(options: KVCalendarManagerOptions) {
		this.storageKey = options.storageKey;
		this.env = options.env;
		this.security = SecurityConfigManager.getInstance();
		this.timezone = new TimezoneDateManager();
	}

	/**
	 * Load subscriptions from KV storage
	 */
	private async loadSubscriptions(): Promise<Record<string, CalendarSubscription>> {
		const stored = await this.env.AUTH_STORE.get(this.storageKey);
		if (!stored) return {};
		
		try {
			return JSON.parse(stored);
		} catch (error) {
			console.error("Failed to parse stored calendar subscriptions:", error);
			return {};
		}
	}

	/**
	 * Save subscriptions to KV storage
	 */
	private async saveSubscriptions(subscriptions: Record<string, CalendarSubscription>): Promise<void> {
		await this.env.AUTH_STORE.put(this.storageKey, JSON.stringify(subscriptions));
	}

	/**
	 * Get cached calendar data from KV
	 */
	private async getCachedCalendar(name: string): Promise<CalendarCache | null> {
		// Check memory cache first
		const memoryCached = this.memoryCache.get(name);
		if (memoryCached && Date.now() - memoryCached.lastFetched.getTime() < this.MEMORY_CACHE_TTL) {
			return memoryCached;
		}

		// Check KV cache
		const cacheKey = `${this.storageKey}:cache:${name}`;
		const cached = await this.env.AUTH_STORE.get(cacheKey);
		if (!cached) return null;

		try {
			const calendarCache = JSON.parse(cached) as CalendarCache;
			// Reconstruct Temporal objects
			calendarCache.events = calendarCache.events.map(event => ({
				...event,
				start: Temporal.ZonedDateTime.from(event.start as any),
				end: Temporal.ZonedDateTime.from(event.end as any),
			}));
			
			// Update memory cache
			this.memoryCache.set(name, calendarCache);
			return calendarCache;
		} catch (error) {
			console.error(`Failed to parse cached calendar ${name}:`, error);
			return null;
		}
	}

	/**
	 * Cache calendar data in KV
	 */
	private async setCachedCalendar(name: string, data: CalendarCache, ttlMinutes: number): Promise<void> {
		const cacheKey = `${this.storageKey}:cache:${name}`;
		
		// Store in memory cache
		this.memoryCache.set(name, data);
		
		// Store in KV with TTL
		await this.env.AUTH_STORE.put(
			cacheKey, 
			JSON.stringify(data),
			{ expirationTtl: ttlMinutes * 60 }
		);
	}

	/**
	 * Fetch and parse calendar from URL
	 */
	private async fetchCalendar(url: string, name: string, refreshInterval: number): Promise<CalendarCache> {
		try {
			const response = await axios.get(url, {
				timeout: 30000,
				maxContentLength: 10 * 1024 * 1024, // 10MB limit
				headers: {
					'User-Agent': 'iCal-MCP-Server/1.0',
				},
			});

			const events: CalendarEvent[] = [];
			const parsedData = ical.parseICS(response.data);

			for (const [key, component] of Object.entries(parsedData)) {
				if (component.type === 'VEVENT') {
					const event = this.parseEvent(component, name, key);
					if (event) {
						events.push(event);
						
						// Handle recurring events
						if (component.rrule) {
							const recurringEvents = this.expandRecurringEvent(event, component.rrule);
							events.push(...recurringEvents);
						}
					}
				}
			}

			return {
				url,
				name,
				refreshInterval,
				lastFetched: new Date(),
				events,
				status: "active",
			};
		} catch (error) {
			console.error(`Failed to fetch calendar ${name}:`, error);
			return {
				url,
				name,
				refreshInterval,
				lastFetched: new Date(),
				events: [],
				status: "error",
				errorMessage: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Parse a single iCal event
	 */
	private parseEvent(component: any, calendarName: string, eventId: string): CalendarEvent | null {
		try {
			if (!component.start || !component.summary) return null;

			const start = this.timezone.parseDate(component.start);
			const end = this.timezone.parseDate(component.end || component.start);
			
			return {
				id: component.uid || eventId,
				summary: component.summary,
				description: component.description,
				start,
				end,
				location: component.location,
				organizer: component.organizer?.val || component.organizer,
				attendees: Array.isArray(component.attendee) 
					? component.attendee.map((a: any) => a.val || a)
					: component.attendee ? [component.attendee.val || component.attendee] : [],
				calendarName,
				isAllDay: !component.start.getHours && !component.start.getMinutes,
				recurrence: component.rrule ? {
					rule: component.rrule.toString(),
				} : undefined,
			};
		} catch (error) {
			console.error(`Failed to parse event ${eventId}:`, error);
			return null;
		}
	}

	/**
	 * Expand recurring events using RRule
	 */
	private expandRecurringEvent(baseEvent: CalendarEvent, rrule: any): CalendarEvent[] {
		try {
			const rule = rrulestr(rrule.toString(), { 
				dtstart: new Date(baseEvent.start.toString())
			});
			
			const now = Temporal.Now.zonedDateTimeISO(this.timezone.getTimezone());
			const futureLimit = now.add({ months: 6 });
			
			const occurrences = rule.between(
				new Date(now.toString()),
				new Date(futureLimit.toString()),
				true,
				(date, index) => index < 100 // Limit to 100 occurrences
			);

			return occurrences.slice(1).map((occurrence, index) => {
				const startZdt = Temporal.ZonedDateTime.from(occurrence.toISOString())
					.withTimeZone(baseEvent.start.timeZoneId);
				const duration = baseEvent.end.since(baseEvent.start);
				
				return {
					...baseEvent,
					id: `${baseEvent.id}_${index + 1}`,
					start: startZdt,
					end: startZdt.add(duration),
				};
			});
		} catch (error) {
			console.error("Failed to expand recurring event:", error);
			return [];
		}
	}

	/**
	 * Validate calendar URL for security
	 */
	private validateCalendarUrl(url: string): void {
		let parsed: URL;

		try {
			parsed = new URL(url);
		} catch {
			throw new Error("Invalid URL format");
		}

		// Only allow HTTP and HTTPS protocols
		const allowedProtocols = ["http:", "https:"];
		if (!allowedProtocols.includes(parsed.protocol)) {
			throw new Error(`Invalid protocol: only ${allowedProtocols.join(", ")} allowed`);
		}

		// Block dangerous hostnames
		const blockedHosts = [
			"localhost", "127.0.0.1", "::1", "0.0.0.0",
			"169.254.169.254", // AWS metadata
			"metadata.google.internal", // GCP metadata
			"metadata", // Generic metadata
		];

		const hostname = parsed.hostname.toLowerCase();
		if (blockedHosts.includes(hostname)) {
			throw new Error("Access to internal resources is not allowed");
		}

		// Check for private IP ranges
		if (this.isPrivateIP(hostname)) {
			throw new Error("Access to private networks is not allowed");
		}

		// Validate URL length
		if (url.length > 2048) {
			throw new Error(`URL exceeds maximum length of 2048 characters`);
		}
	}

	/**
	 * Check if hostname is a private IP
	 */
	private isPrivateIP(hostname: string): boolean {
		// Check if it's an IP address
		if (!isIP(hostname)) return false;

		// Private IPv4 ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
		const ipParts = hostname.split('.').map(Number);
		if (ipParts.length === 4) {
			const [a, b] = ipParts;
			return (a === 10) || 
				   (a === 172 && b >= 16 && b <= 31) || 
				   (a === 192 && b === 168) || 
				   (a === 127);
		}

		// Private IPv6 ranges (simplified check)
		return hostname.startsWith('::1') || hostname.startsWith('fc') || hostname.startsWith('fd');
	}

	/**
	 * Validate calendar name
	 */
	private validateCalendarName(name: string): void {
		if (!name || name.trim().length === 0) {
			throw new Error("Calendar name cannot be empty");
		}

		if (name.length > 100) {
			throw new Error("Calendar name exceeds maximum length of 100 characters");
		}

		// Allow only alphanumeric, spaces, hyphens, underscores
		if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) {
			throw new Error("Calendar name contains invalid characters");
		}
	}

	/**
	 * Validate refresh interval
	 */
	private validateRefreshInterval(refreshInterval: number): void {
		if (!Number.isInteger(refreshInterval) || refreshInterval < 1 || refreshInterval > 10080) {
			throw new Error("Refresh interval must be between 1 and 10080 minutes");
		}
	}

	/**
	 * Subscribe to a new calendar
	 */
	async subscribeToCalendar(url: string, name: string, refreshInterval: number = 60): Promise<void> {
		this.validateCalendarUrl(url);
		this.validateCalendarName(name);
		this.validateRefreshInterval(refreshInterval);

		const subscriptions = await this.loadSubscriptions();
		
		if (subscriptions[name]) {
			throw new Error(`Calendar "${name}" already exists`);
		}

		// Fetch the calendar to validate it works
		const calendar = await this.fetchCalendar(url, name, refreshInterval);
		
		// Save subscription
		subscriptions[name] = { url, name, refreshInterval };
		await this.saveSubscriptions(subscriptions);
		
		// Cache the calendar data
		await this.setCachedCalendar(name, calendar, refreshInterval);
	}

	/**
	 * Unsubscribe from a calendar
	 */
	async unsubscribeFromCalendar(name: string): Promise<void> {
		this.validateCalendarName(name);

		const subscriptions = await this.loadSubscriptions();
		
		if (!subscriptions[name]) {
			throw new Error(`Calendar "${name}" not found`);
		}

		// Remove from subscriptions
		delete subscriptions[name];
		await this.saveSubscriptions(subscriptions);
		
		// Clear cache
		const cacheKey = `${this.storageKey}:cache:${name}`;
		await this.env.AUTH_STORE.delete(cacheKey);
		this.memoryCache.delete(name);
	}

	/**
	 * List all subscribed calendars
	 */
	async listCalendars(): Promise<Array<{name: string; url: string; status: string; refreshInterval: number}>> {
		const subscriptions = await this.loadSubscriptions();
		
		const calendars = [];
		for (const [name, subscription] of Object.entries(subscriptions)) {
			const cached = await this.getCachedCalendar(name);
			calendars.push({
				name: subscription.name,
				url: subscription.url,
				status: cached?.status || "unknown",
				refreshInterval: subscription.refreshInterval,
			});
		}
		
		return calendars;
	}

	/**
	 * Get events with optional filtering
	 */
	async getEvents(startDate?: string, endDate?: string, calendarName?: string): Promise<CalendarEvent[]> {
		const subscriptions = await this.loadSubscriptions();
		const events: CalendarEvent[] = [];
		
		const calendarsToCheck = calendarName 
			? [calendarName]
			: Object.keys(subscriptions);
		
		for (const name of calendarsToCheck) {
			if (!subscriptions[name]) continue;
			
			const cached = await this.getCachedCalendar(name);
			if (!cached) {
				// Fetch fresh data
				const fresh = await this.fetchCalendar(
					subscriptions[name].url,
					subscriptions[name].name,
					subscriptions[name].refreshInterval
				);
				await this.setCachedCalendar(name, fresh, fresh.refreshInterval);
				events.push(...fresh.events);
			} else {
				// Check if cache needs refresh
				const cacheAge = Date.now() - cached.lastFetched.getTime();
				const maxAge = cached.refreshInterval * 60 * 1000;
				
				if (cacheAge > maxAge) {
					const fresh = await this.fetchCalendar(cached.url, cached.name, cached.refreshInterval);
					await this.setCachedCalendar(name, fresh, fresh.refreshInterval);
					events.push(...fresh.events);
				} else {
					events.push(...cached.events);
				}
			}
		}

		// Filter by date range if specified
		return this.filterEventsByDateRange(events, startDate, endDate);
	}

	/**
	 * Filter events by date range
	 */
	private filterEventsByDateRange(events: CalendarEvent[], startDate?: string, endDate?: string): CalendarEvent[] {
		if (!startDate && !endDate) return events;

		const start = startDate ? this.timezone.parseDate(startDate) : null;
		const end = endDate ? this.timezone.parseDate(endDate) : null;

		return events.filter(event => {
			if (start && Temporal.ZonedDateTime.compare(event.end, start) < 0) return false;
			if (end && Temporal.ZonedDateTime.compare(event.start, end) > 0) return false;
			return true;
		});
	}

	/**
	 * Search events by query
	 */
	async searchEvents(query: string, calendarName?: string, startDate?: string, endDate?: string): Promise<CalendarEvent[]> {
		const events = await this.getEvents(startDate, endDate, calendarName);
		const searchTerm = query.toLowerCase();

		return events.filter(event =>
			event.summary.toLowerCase().includes(searchTerm) ||
			event.description?.toLowerCase().includes(searchTerm) ||
			event.location?.toLowerCase().includes(searchTerm)
		);
	}

	/**
	 * Get daily agenda for a specific date
	 */
	async getDailyAgenda(date: string, calendarName?: string): Promise<CalendarEvent[]> {
		const targetDate = this.timezone.parseDate(date);
		const dayStart = targetDate.startOfDay();
		const dayEnd = dayStart.add({ days: 1 });

		const events = await this.getEvents(
			dayStart.toString(),
			dayEnd.toString(),
			calendarName
		);

		return events.sort((a, b) => 
			Temporal.ZonedDateTime.compare(a.start, b.start)
		);
	}

	/**
	 * Get upcoming events
	 */
	async getUpcomingEvents(limit: number = 10, calendarName?: string): Promise<CalendarEvent[]> {
		const now = Temporal.Now.zonedDateTimeISO(this.timezone.getTimezone());
		const futureLimit = now.add({ days: 30 });

		const events = await this.getEvents(
			now.toString(),
			futureLimit.toString(),
			calendarName
		);

		return events
			.filter(event => Temporal.ZonedDateTime.compare(event.start, now) >= 0)
			.sort((a, b) => Temporal.ZonedDateTime.compare(a.start, b.start))
			.slice(0, limit);
	}
}
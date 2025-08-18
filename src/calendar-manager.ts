import axios from "axios";
import * as ical from "node-ical";
import NodeCache from "node-cache";
import { promises as fs } from "fs";
import path from "path";
import { TimezoneManager } from "./timezone-manager.js";
import { RRule, rrulestr } from "rrule";
import { isIP } from "net";
import { SecurityConfigManager } from "./security-config.js";

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
  start: Date;
  end: Date;
  location?: string;
  organizer?: string;
  attendees?: string[];
  calendarName: string;
  isAllDay: boolean;
  recurrence?: any;
}

export class CalendarManager {
  private cache: NodeCache;
  private subscriptions: Map<string, CalendarSubscription>;
  private configPath: string;
  private timezoneManager: TimezoneManager;
  private securityConfig: SecurityConfigManager;

  constructor(configPath?: string) {
    // Initialize security configuration first
    this.securityConfig = SecurityConfigManager.getInstance();
    const config = this.securityConfig.getConfig();

    // Cache with security-aware limits
    this.cache = new NodeCache({
      stdTTL: 3600,
      maxKeys: config.maxCacheSize,
      deleteOnExpire: true,
      checkperiod: 600, // Check for expired keys every 10 minutes
    });
    this.subscriptions = new Map();
    this.timezoneManager = TimezoneManager.getInstance();

    // Set up config path
    if (configPath) {
      this.configPath = configPath;
    } else {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      this.configPath = path.join(homeDir, ".ical-mcp-config.json");
    }

    // Load saved subscriptions synchronously
    this.loadSubscriptionsSync();
  }

  /**
   * Validates a calendar URL to prevent SSRF attacks
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
      throw new Error(
        `Invalid protocol: only ${allowedProtocols.join(", ")} allowed`,
      );
    }

    // Block dangerous hostnames
    const blockedHosts = [
      "localhost",
      "127.0.0.1",
      "::1",
      "0.0.0.0",
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

    // Validate URL length using security config
    const config = this.securityConfig.getConfig();
    if (url.length > config.maxUrlLength) {
      throw new Error(
        `URL exceeds maximum length of ${config.maxUrlLength} characters`,
      );
    }
  }

  /**
   * Checks if a hostname or IP address is in a private range
   */
  private isPrivateIP(hostname: string): boolean {
    // Try to parse as IP address
    const ipVersion = isIP(hostname);
    if (ipVersion === 0) {
      // Not an IP address, could be a hostname resolving to private IP
      // For now, we'll allow hostnames but could add DNS resolution checking
      return false;
    }

    if (ipVersion === 4) {
      // IPv4 private ranges
      const ip = hostname.split(".").map(Number);
      if (ip.length !== 4 || ip.some((octet) => octet < 0 || octet > 255)) {
        return false;
      }

      // 10.0.0.0/8
      if (ip[0] === 10) return true;

      // 172.16.0.0/12
      if (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) return true;

      // 192.168.0.0/16
      if (ip[0] === 192 && ip[1] === 168) return true;

      // Loopback 127.0.0.0/8
      if (ip[0] === 127) return true;

      // Link-local 169.254.0.0/16
      if (ip[0] === 169 && ip[1] === 254) return true;
    }

    if (ipVersion === 6) {
      // IPv6 private ranges
      const lowerHostname = hostname.toLowerCase();

      // Loopback ::1
      if (lowerHostname === "::1") return true;

      // Link-local fe80::/10
      if (lowerHostname.startsWith("fe80:")) return true;

      // Unique local fc00::/7
      if (lowerHostname.startsWith("fc") || lowerHostname.startsWith("fd"))
        return true;
    }

    return false;
  }

  /**
   * Validates and sanitizes calendar names
   */
  private validateCalendarName(name: string): void {
    if (!this.securityConfig.isValidCalendarName(name)) {
      const config = this.securityConfig.getConfig();
      throw new Error(
        `Invalid calendar name. Must be 1-${config.maxCalendarNameLength} characters, alphanumeric with spaces, hyphens, underscores, dots only. No path traversal sequences allowed.`,
      );
    }
  }

  /**
   * Validates refresh interval
   */
  private validateRefreshInterval(refreshInterval: number): void {
    if (
      !Number.isInteger(refreshInterval) ||
      refreshInterval < 1 ||
      refreshInterval > 10080
    ) {
      throw new Error(
        "Refresh interval must be between 1 and 10080 minutes (1 week)",
      );
    }
  }

  /**
   * Validates date ranges to prevent excessive queries
   */
  private validateDateRange(startDate: Date, endDate: Date): void {
    if (!this.securityConfig.isValidDateRange(startDate, endDate)) {
      const config = this.securityConfig.getConfig();
      throw new Error(
        `Invalid date range. Must be valid dates with start before end, and range cannot exceed ${config.maxDateRangeDays} days.`,
      );
    }
  }

  /**
   * Validates search query parameters
   */
  private validateSearchQuery(query: string): void {
    if (!this.securityConfig.isValidSearchQuery(query)) {
      const config = this.securityConfig.getConfig();
      throw new Error(
        `Invalid search query. Must be 1-${config.maxSearchQueryLength} characters and not just whitespace.`,
      );
    }
  }

  /**
   * Sanitizes error messages to prevent information disclosure
   */
  private sanitizeErrorMessage(error: any, context: string): string {
    // Never expose stack traces or detailed internal errors in production
    if (process.env.NODE_ENV === "production") {
      // Return generic error messages for production
      switch (context) {
        case "fetch":
          return "Failed to fetch calendar data";
        case "parse":
          return "Failed to parse calendar data";
        case "network":
          return "Network error occurred";
        default:
          return "An error occurred while processing calendar data";
      }
    }

    // In development, provide more details but still sanitize sensitive info
    if (error && error.message) {
      let message = error.message;

      // Remove potential sensitive information
      message = message.replace(/https?:\/\/[^\s]+/gi, "[URL]");
      message = message.replace(
        /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
        "[IP]",
      );
      message = message.replace(/Bearer\s+[^\s]+/gi, "[TOKEN]");
      message = message.replace(/password=\w+/gi, "password=[REDACTED]");

      return `${context}: ${message}`;
    }

    return `${context}: Unknown error occurred`;
  }

  private loadSubscriptionsSync() {
    try {
      const fsSync = require("fs");
      const data = fsSync.readFileSync(this.configPath, "utf-8");
      const saved = JSON.parse(data);
      for (const [name, sub] of Object.entries(saved)) {
        this.subscriptions.set(name, sub as CalendarSubscription);
      }
    } catch (_error) {
      // File doesn't exist yet, that's ok
    }
  }

  private async loadSubscriptions() {
    try {
      const data = await fs.readFile(this.configPath, "utf-8");
      const saved = JSON.parse(data);
      for (const [name, sub] of Object.entries(saved)) {
        this.subscriptions.set(name, sub as CalendarSubscription);
      }
    } catch (_error) {
      // File doesn't exist yet, that's ok
    }
  }

  private async saveSubscriptions() {
    const data = Object.fromEntries(this.subscriptions);
    await fs.writeFile(this.configPath, JSON.stringify(data, null, 2));
  }

  async subscribeCalendar(
    url: string,
    name: string,
    refreshInterval: number = 60,
  ) {
    // Validate and sanitize inputs
    this.validateCalendarName(name);
    this.validateCalendarUrl(url);
    this.validateRefreshInterval(refreshInterval);

    // Check if already subscribed
    if (this.subscriptions.has(name)) {
      throw new Error(`Calendar "${name}" already exists`);
    }

    // Check subscription limits using security config
    const config = this.securityConfig.getConfig();
    if (this.subscriptions.size >= config.maxCalendarSubscriptions) {
      throw new Error(
        `Maximum number of calendar subscriptions (${config.maxCalendarSubscriptions}) reached`,
      );
    }

    // Test fetching the calendar
    await this.fetchCalendar(url);

    // Save subscription
    this.subscriptions.set(name, {
      url,
      name,
      refreshInterval,
      lastFetched: new Date(),
    });

    await this.saveSubscriptions();
  }

  unsubscribeCalendar(name: string) {
    if (!this.subscriptions.has(name)) {
      throw new Error(`Calendar "${name}" not found`);
    }

    this.subscriptions.delete(name);
    this.cache.del(`calendar:${name}`);
    this.saveSubscriptions();
  }

  listCalendars(): CalendarSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  private async fetchCalendar(url: string): Promise<ical.CalendarResponse> {
    const config = this.securityConfig.getConfig();

    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": "iCal-MCP/1.0",
          Accept: "text/calendar",
        },
        timeout: config.fetchTimeoutMs,
        maxContentLength: config.maxContentSizeBytes,
        maxBodyLength: config.maxContentSizeBytes,
      });

      // Parse the calendar data
      try {
        const calendarData = ical.parseICS(response.data);
        return calendarData;
      } catch (parseError) {
        throw new Error(this.sanitizeErrorMessage(parseError, "parse"));
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(this.sanitizeErrorMessage(error, "fetch"));
      }
      throw new Error(this.sanitizeErrorMessage(error, "network"));
    }
  }

  private async getCalendarData(name: string): Promise<ical.CalendarResponse> {
    const subscription = this.subscriptions.get(name);
    if (!subscription) {
      throw new Error(`Calendar "${name}" not found`);
    }

    const cacheKey = `calendar:${name}`;
    const cached = this.cache.get<ical.CalendarResponse>(cacheKey);

    // Check if we need to refresh
    const now = new Date();
    const lastFetched = subscription.lastFetched
      ? new Date(subscription.lastFetched)
      : null;
    const shouldRefresh =
      !cached ||
      !lastFetched ||
      now.getTime() - lastFetched.getTime() >
        subscription.refreshInterval * 60 * 1000;

    if (shouldRefresh) {
      const data = await this.fetchCalendar(subscription.url);
      this.cache.set(cacheKey, data, subscription.refreshInterval * 60);
      subscription.lastFetched = now;
      await this.saveSubscriptions();
      return data;
    }

    return cached!;
  }

  private parseEvent(
    vevent: ical.VEvent,
    calendarName: string,
  ): CalendarEvent | null {
    // Skip events without required fields
    if (!vevent.summary || !vevent.start) {
      return null;
    }

    // Parse start and end dates
    let start: Date;
    let end: Date;

    // Handle different date formats
    if (vevent.start instanceof Date) {
      start = vevent.start;
    } else if (typeof vevent.start === "string") {
      start = new Date(vevent.start);
    } else if (
      vevent.start &&
      typeof vevent.start === "object" &&
      "dateTime" in (vevent.start as any)
    ) {
      // Handle complex date objects from node-ical
      start = new Date((vevent.start as any).dateTime || vevent.start);
    } else {
      start = new Date(vevent.start);
    }

    if (vevent.end instanceof Date) {
      end = vevent.end;
    } else if (vevent.end) {
      if (typeof vevent.end === "string") {
        end = new Date(vevent.end);
      } else if (
        typeof vevent.end === "object" &&
        "dateTime" in (vevent.end as any)
      ) {
        end = new Date((vevent.end as any).dateTime || vevent.end);
      } else {
        end = new Date(vevent.end);
      }
    } else {
      // Default to 1 hour duration if no end time
      end = new Date(start.getTime() + 3600000);
    }

    return {
      id: vevent.uid || `${calendarName}-${start.getTime()}`,
      summary: vevent.summary,
      description: vevent.description,
      start,
      end,
      location: vevent.location,
      organizer:
        typeof vevent.organizer === "string"
          ? vevent.organizer
          : vevent.organizer?.val,
      attendees: vevent.attendee
        ? (Array.isArray(vevent.attendee)
            ? vevent.attendee
            : [vevent.attendee]
          ).map((a) => (typeof a === "string" ? a : a.val))
        : undefined,
      calendarName,
      isAllDay: vevent.datetype === "date",
      recurrence: vevent.rrule,
    };
  }

  async getEvents(
    startDate: Date,
    endDate: Date,
    calendarName?: string,
    limit: number = 50,
  ): Promise<CalendarEvent[]> {
    // Validate inputs
    this.validateDateRange(startDate, endDate);

    if (limit < 1 || limit > 1000) {
      throw new Error("Limit must be between 1 and 1000");
    }

    if (calendarName) {
      this.validateCalendarName(calendarName);
      if (!this.subscriptions.has(calendarName)) {
        throw new Error(`Calendar "${calendarName}" not found`);
      }
    }

    const calendarsToCheck = calendarName
      ? [calendarName]
      : Array.from(this.subscriptions.keys());

    const allEvents: CalendarEvent[] = [];

    for (const name of calendarsToCheck) {
      try {
        const calendarData = await this.getCalendarData(name);
        const processedUIDs = new Set<string>();

        for (const [_key, value] of Object.entries(calendarData)) {
          if (value.type === "VEVENT") {
            const vevent = value as ical.VEvent;

            // Skip if we've already processed this UID (node-ical might have duplicates)
            if (vevent.uid && processedUIDs.has(vevent.uid)) {
              continue;
            }
            if (vevent.uid) {
              processedUIDs.add(vevent.uid);
            }

            // Check if this is a recurring event
            if (vevent.rrule) {
              // Expand recurring events
              const expandedEvents = this.expandRecurringEvent(
                vevent,
                name,
                startDate,
                endDate,
              );
              allEvents.push(...expandedEvents);
            } else {
              // Single event
              const event = this.parseEvent(vevent, name);
              if (event && event.start >= startDate && event.start <= endDate) {
                allEvents.push(event);
              }
            }
          }
        }
      } catch (error) {
        // Use sanitized error logging
        const sanitizedMessage = this.sanitizeErrorMessage(
          error,
          "calendar-processing",
        );
        console.error(`Error fetching calendar ${name}:`, sanitizedMessage);
      }
    }

    // Sort by start date and apply limit
    return allEvents
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, limit);
  }

  async searchEvents(
    query: string,
    calendarName?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<CalendarEvent[]> {
    // Validate inputs
    this.validateSearchQuery(query);

    if (calendarName) {
      this.validateCalendarName(calendarName);
      if (!this.subscriptions.has(calendarName)) {
        throw new Error(`Calendar "${calendarName}" not found`);
      }
    }

    if (startDate && endDate) {
      this.validateDateRange(startDate, endDate);
    }

    const calendarsToCheck = calendarName
      ? [calendarName]
      : Array.from(this.subscriptions.keys());

    const searchResults: CalendarEvent[] = [];
    const queryLower = query.toLowerCase();

    for (const name of calendarsToCheck) {
      try {
        const calendarData = await this.getCalendarData(name);

        for (const [_key, value] of Object.entries(calendarData)) {
          if (value.type === "VEVENT") {
            const event = this.parseEvent(value as ical.VEvent, name);
            if (!event) continue;

            // Check date range if provided
            if (startDate && event.start < startDate) continue;
            if (endDate && event.start > endDate) continue;

            // Search in summary and description
            const summaryMatch = event.summary
              ?.toLowerCase()
              .includes(queryLower);
            const descriptionMatch = event.description
              ?.toLowerCase()
              .includes(queryLower);

            if (summaryMatch || descriptionMatch) {
              searchResults.push(event);
            }
          }
        }
      } catch (error) {
        const sanitizedMessage = this.sanitizeErrorMessage(error, "search");
        console.error(`Error searching calendar ${name}:`, sanitizedMessage);
      }
    }

    return searchResults.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async getUpcomingEvents(
    days: number = 7,
    calendarName?: string,
    limit: number = 20,
  ): Promise<CalendarEvent[]> {
    const now = new Date();
    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    return this.getEvents(now, endDate, calendarName, limit);
  }

  private expandRecurringEvent(
    vevent: ical.VEvent,
    calendarName: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const startTime = Date.now();
    const config = this.securityConfig.getConfig();
    const MAX_PROCESSING_TIME = config.rruleTimeoutMs;
    const MAX_OCCURRENCES = config.maxRRuleOccurrences;

    try {
      // Get the base event start date
      let dtstart: Date;
      if (vevent.start instanceof Date) {
        dtstart = vevent.start;
      } else if (typeof vevent.start === "string") {
        dtstart = new Date(vevent.start);
      } else if (
        vevent.start &&
        typeof vevent.start === "object" &&
        "dateTime" in (vevent.start as any)
      ) {
        dtstart = new Date((vevent.start as any).dateTime || vevent.start);
      } else {
        dtstart = new Date(vevent.start);
      }

      // Calculate event duration
      let dtend: Date;
      if (vevent.end instanceof Date) {
        dtend = vevent.end;
      } else if (vevent.end) {
        if (typeof vevent.end === "string") {
          dtend = new Date(vevent.end);
        } else if (
          typeof vevent.end === "object" &&
          "dateTime" in (vevent.end as any)
        ) {
          dtend = new Date((vevent.end as any).dateTime || vevent.end);
        } else {
          dtend = new Date(vevent.end);
        }
      } else {
        dtend = new Date(dtstart.getTime() + 3600000); // 1 hour default
      }
      const duration = dtend.getTime() - dtstart.getTime();

      // Parse the RRULE
      let rrule: RRule;
      if (typeof vevent.rrule === "string") {
        rrule = rrulestr(vevent.rrule);
      } else if (vevent.rrule && typeof vevent.rrule === "object") {
        // Convert node-ical rrule object to RRule options
        const rruleObj = vevent.rrule as any;
        const rruleOptions = rruleObj.origOptions || rruleObj.options;
        if (rruleOptions) {
          // Map weekday numbers to RRule constants
          let byweekday = undefined;
          if (rruleOptions.byweekday) {
            byweekday = rruleOptions.byweekday.map(
              (day: number | { weekday: number }) => {
                const dayNum = typeof day === "number" ? day : day.weekday;
                // RRule uses different constants: MO=0, TU=1, etc.
                return [
                  RRule.MO,
                  RRule.TU,
                  RRule.WE,
                  RRule.TH,
                  RRule.FR,
                  RRule.SA,
                  RRule.SU,
                ][dayNum];
              },
            );
          }

          // Create RRule with proper dtstart
          rrule = new RRule({
            freq: rruleOptions.freq,
            interval: rruleOptions.interval || 1,
            byweekday: byweekday,
            until: rruleOptions.until
              ? new Date(rruleOptions.until)
              : undefined,
            count: rruleOptions.count,
            dtstart: dtstart, // Use the actual event start date
            wkst: rruleOptions.wkst,
            bymonth: rruleOptions.bymonth,
            bymonthday: rruleOptions.bymonthday,
            byyearday: rruleOptions.byyearday,
            byweekno: rruleOptions.byweekno,
            byhour: rruleOptions.byhour,
            byminute: rruleOptions.byminute,
            bysecond: rruleOptions.bysecond,
          });
        } else {
          return [];
        }
      } else {
        return [];
      }

      // Get occurrences within the date range
      const occurrences = rrule.between(rangeStart, rangeEnd, true);

      // Limit occurrences to prevent memory exhaustion
      const limitedOccurrences = occurrences.slice(0, MAX_OCCURRENCES);

      // Create an event for each occurrence
      for (const occurrence of limitedOccurrences) {
        // Check processing timeout
        if (Date.now() - startTime > MAX_PROCESSING_TIME) {
          console.warn(
            `RRULE processing timeout exceeded for event ${vevent.uid}, stopping expansion`,
          );
          break;
        }

        const eventStart = occurrence;
        const eventEnd = new Date(occurrence.getTime() + duration);

        events.push({
          id: `${vevent.uid}-${occurrence.getTime()}`,
          summary: vevent.summary || "",
          description: vevent.description,
          start: eventStart,
          end: eventEnd,
          location: vevent.location,
          organizer:
            typeof vevent.organizer === "string"
              ? vevent.organizer
              : vevent.organizer?.val,
          attendees: vevent.attendee
            ? (Array.isArray(vevent.attendee)
                ? vevent.attendee
                : [vevent.attendee]
              ).map((a) => (typeof a === "string" ? a : a.val))
            : undefined,
          calendarName,
          isAllDay: vevent.datetype === "date",
          recurrence: vevent.rrule,
        });
      }
    } catch (error) {
      const sanitizedMessage = this.sanitizeErrorMessage(
        error,
        "rrule-expansion",
      );
      console.error(`Error expanding recurring event: ${sanitizedMessage}`);
      // Don't log full event data in production
      if (process.env.NODE_ENV !== "production") {
        console.error("Event data:", vevent);
      }
    }

    return events;
  }
}

import axios from "axios";
import * as ical from "node-ical";
import NodeCache from "node-cache";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { TimezoneManager } from "./timezone-manager.js";
import { RRule, RRuleSet, rrulestr } from "rrule";

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

  constructor() {
    // Cache with default TTL of 1 hour
    this.cache = new NodeCache({ stdTTL: 3600 });
    this.subscriptions = new Map();
    this.timezoneManager = TimezoneManager.getInstance();
    
    // Set up config path
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.configPath = path.join(homeDir, '.ical-mcp-config.json');
    
    // Load saved subscriptions synchronously
    this.loadSubscriptionsSync();
  }

  private loadSubscriptionsSync() {
    try {
      const fsSync = require('fs');
      const data = fsSync.readFileSync(this.configPath, 'utf-8');
      const saved = JSON.parse(data);
      for (const [name, sub] of Object.entries(saved)) {
        this.subscriptions.set(name, sub as CalendarSubscription);
      }
    } catch (error) {
      // File doesn't exist yet, that's ok
    }
  }

  private async loadSubscriptions() {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const saved = JSON.parse(data);
      for (const [name, sub] of Object.entries(saved)) {
        this.subscriptions.set(name, sub as CalendarSubscription);
      }
    } catch (error) {
      // File doesn't exist yet, that's ok
    }
  }

  private async saveSubscriptions() {
    const data = Object.fromEntries(this.subscriptions);
    await fs.writeFile(this.configPath, JSON.stringify(data, null, 2));
  }

  async subscribeCalendar(url: string, name: string, refreshInterval: number = 60) {
    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new Error("Invalid URL provided");
    }

    // Check if already subscribed
    if (this.subscriptions.has(name)) {
      throw new Error(`Calendar "${name}" already exists`);
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
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'iCal-MCP/1.0',
          'Accept': 'text/calendar',
        },
        timeout: 30000,
      });

      // Parse the calendar data
      const calendarData = ical.parseICS(response.data);
      return calendarData;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to fetch calendar: ${error.message}`);
      }
      throw error;
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
    const lastFetched = subscription.lastFetched ? new Date(subscription.lastFetched) : null;
    const shouldRefresh = !cached || !lastFetched || 
      (now.getTime() - lastFetched.getTime()) > subscription.refreshInterval * 60 * 1000;

    if (shouldRefresh) {
      const data = await this.fetchCalendar(subscription.url);
      this.cache.set(cacheKey, data, subscription.refreshInterval * 60);
      subscription.lastFetched = now;
      await this.saveSubscriptions();
      return data;
    }

    return cached!;
  }

  private parseEvent(vevent: ical.VEvent, calendarName: string): CalendarEvent | null {
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
    } else if (typeof vevent.start === 'string') {
      start = new Date(vevent.start);
    } else if (vevent.start && typeof vevent.start === 'object' && 'dateTime' in (vevent.start as any)) {
      // Handle complex date objects from node-ical
      start = new Date((vevent.start as any).dateTime || vevent.start);
    } else {
      start = new Date(vevent.start);
    }

    if (vevent.end instanceof Date) {
      end = vevent.end;
    } else if (vevent.end) {
      if (typeof vevent.end === 'string') {
        end = new Date(vevent.end);
      } else if (typeof vevent.end === 'object' && 'dateTime' in (vevent.end as any)) {
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
      organizer: typeof vevent.organizer === 'string' ? vevent.organizer : vevent.organizer?.val,
      attendees: vevent.attendee ? 
        (Array.isArray(vevent.attendee) ? vevent.attendee : [vevent.attendee])
          .map(a => typeof a === 'string' ? a : a.val) : undefined,
      calendarName,
      isAllDay: vevent.datetype === 'date',
      recurrence: vevent.rrule,
    };
  }

  async getEvents(
    startDate: Date,
    endDate: Date,
    calendarName?: string,
    limit: number = 50
  ): Promise<CalendarEvent[]> {
    const calendarsToCheck = calendarName 
      ? [calendarName]
      : Array.from(this.subscriptions.keys());

    const allEvents: CalendarEvent[] = [];

    for (const name of calendarsToCheck) {
      try {
        const calendarData = await this.getCalendarData(name);
        const processedUIDs = new Set<string>();
        
        for (const [key, value] of Object.entries(calendarData)) {
          if (value.type === 'VEVENT') {
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
              const expandedEvents = this.expandRecurringEvent(vevent, name, startDate, endDate);
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
        console.error(`Error fetching calendar ${name}:`, error);
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
    endDate?: Date
  ): Promise<CalendarEvent[]> {
    const calendarsToCheck = calendarName 
      ? [calendarName]
      : Array.from(this.subscriptions.keys());

    const searchResults: CalendarEvent[] = [];
    const queryLower = query.toLowerCase();

    for (const name of calendarsToCheck) {
      try {
        const calendarData = await this.getCalendarData(name);
        
        for (const [key, value] of Object.entries(calendarData)) {
          if (value.type === 'VEVENT') {
            const event = this.parseEvent(value as ical.VEvent, name);
            if (!event) continue;

            // Check date range if provided
            if (startDate && event.start < startDate) continue;
            if (endDate && event.start > endDate) continue;

            // Search in summary and description
            const summaryMatch = event.summary?.toLowerCase().includes(queryLower);
            const descriptionMatch = event.description?.toLowerCase().includes(queryLower);
            
            if (summaryMatch || descriptionMatch) {
              searchResults.push(event);
            }
          }
        }
      } catch (error) {
        console.error(`Error searching calendar ${name}:`, error);
      }
    }

    return searchResults.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async getUpcomingEvents(
    days: number = 7,
    calendarName?: string,
    limit: number = 20
  ): Promise<CalendarEvent[]> {
    const now = new Date();
    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    
    return this.getEvents(now, endDate, calendarName, limit);
  }

  private expandRecurringEvent(
    vevent: ical.VEvent,
    calendarName: string,
    rangeStart: Date,
    rangeEnd: Date
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    
    try {
      // Get the base event start date
      let dtstart: Date;
      if (vevent.start instanceof Date) {
        dtstart = vevent.start;
      } else if (typeof vevent.start === 'string') {
        dtstart = new Date(vevent.start);
      } else if (vevent.start && typeof vevent.start === 'object' && 'dateTime' in (vevent.start as any)) {
        dtstart = new Date((vevent.start as any).dateTime || vevent.start);
      } else {
        dtstart = new Date(vevent.start);
      }

      // Calculate event duration
      let dtend: Date;
      if (vevent.end instanceof Date) {
        dtend = vevent.end;
      } else if (vevent.end) {
        if (typeof vevent.end === 'string') {
          dtend = new Date(vevent.end);
        } else if (typeof vevent.end === 'object' && 'dateTime' in (vevent.end as any)) {
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
      if (typeof vevent.rrule === 'string') {
        rrule = rrulestr(vevent.rrule);
      } else if (vevent.rrule && typeof vevent.rrule === 'object') {
        // Convert node-ical rrule object to RRule options
        const rruleObj = vevent.rrule as any;
        const rruleOptions = rruleObj.origOptions || rruleObj.options;
        if (rruleOptions) {
          // Map weekday numbers to RRule constants
          let byweekday = undefined;
          if (rruleOptions.byweekday) {
            byweekday = rruleOptions.byweekday.map((day: number | {weekday: number}) => {
              const dayNum = typeof day === 'number' ? day : day.weekday;
              // RRule uses different constants: MO=0, TU=1, etc.
              return [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU][dayNum];
            });
          }

          // Create RRule with proper dtstart
          rrule = new RRule({
            freq: rruleOptions.freq,
            interval: rruleOptions.interval || 1,
            byweekday: byweekday,
            until: rruleOptions.until ? new Date(rruleOptions.until) : undefined,
            count: rruleOptions.count,
            dtstart: dtstart, // Use the actual event start date
            wkst: rruleOptions.wkst,
            bymonth: rruleOptions.bymonth,
            bymonthday: rruleOptions.bymonthday,
            byyearday: rruleOptions.byyearday,
            byweekno: rruleOptions.byweekno,
            byhour: rruleOptions.byhour,
            byminute: rruleOptions.byminute,
            bysecond: rruleOptions.bysecond
          });
        } else {
          return [];
        }
      } else {
        return [];
      }

      // Get occurrences within the date range
      const occurrences = rrule.between(rangeStart, rangeEnd, true);
      
      // Create an event for each occurrence
      for (const occurrence of occurrences) {
        const eventStart = occurrence;
        const eventEnd = new Date(occurrence.getTime() + duration);
        
        events.push({
          id: `${vevent.uid}-${occurrence.getTime()}`,
          summary: vevent.summary || '',
          description: vevent.description,
          start: eventStart,
          end: eventEnd,
          location: vevent.location,
          organizer: typeof vevent.organizer === 'string' ? vevent.organizer : vevent.organizer?.val,
          attendees: vevent.attendee ? 
            (Array.isArray(vevent.attendee) ? vevent.attendee : [vevent.attendee])
              .map(a => typeof a === 'string' ? a : a.val) : undefined,
          calendarName,
          isAllDay: vevent.datetype === 'date',
          recurrence: vevent.rrule,
        });
      }
    } catch (error) {
      console.error(`Error expanding recurring event: ${error}`);
      console.error('Event data:', vevent);
    }
    
    return events;
  }
}
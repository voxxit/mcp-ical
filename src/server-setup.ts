import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CalendarManager } from "./calendar-manager.js";
import { TimezoneManager } from "./timezone-manager.js";

export function setupServer(calendarManager?: CalendarManager): Server {
  const server = new Server(
    {
      name: "ical-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Use provided CalendarManager or create a new one
  if (!calendarManager) {
    calendarManager = new CalendarManager();
  }
  const timezoneManager = TimezoneManager.getInstance();

  // Store handlers for testing
  const listToolsHandler = async () => ({
    tools: [
      {
        name: "subscribe_calendar",
        description: "Subscribe to an iCalendar feed from a URL",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL of the iCalendar feed (.ics file)",
            },
            name: {
              type: "string",
              description: "A friendly name for this calendar subscription",
            },
            refreshInterval: {
              type: "number",
              description: "Refresh interval in minutes (default: 60)",
              default: 60,
            },
          },
          required: ["url", "name"],
        },
      },
      {
        name: "list_calendars",
        description: "List all subscribed calendars",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "unsubscribe_calendar",
        description: "Unsubscribe from a calendar",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the calendar to unsubscribe from",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "get_events",
        description: "Get events from calendars within a date range",
        inputSchema: {
          type: "object",
          properties: {
            calendarName: {
              type: "string",
              description: "Optional: specific calendar name (all calendars if not specified)",
            },
            startDate: {
              type: "string",
              description: "Start date in ISO format (YYYY-MM-DD)",
            },
            endDate: {
              type: "string",
              description: "End date in ISO format (YYYY-MM-DD)",
            },
            limit: {
              type: "number",
              description: "Maximum number of events to return (default: 50)",
              default: 50,
            },
          },
          required: ["startDate", "endDate"],
        },
      },
      {
        name: "search_events",
        description: "Search for events by text in summary or description",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text to search for in event summaries and descriptions",
            },
            calendarName: {
              type: "string",
              description: "Optional: specific calendar name (all calendars if not specified)",
            },
            startDate: {
              type: "string",
              description: "Optional: start date for search range in ISO format",
            },
            endDate: {
              type: "string",
              description: "Optional: end date for search range in ISO format",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_upcoming_events",
        description: "Get upcoming events from now",
        inputSchema: {
          type: "object",
          properties: {
            calendarName: {
              type: "string",
              description: "Optional: specific calendar name (all calendars if not specified)",
            },
            days: {
              type: "number",
              description: "Number of days to look ahead (default: 7)",
              default: 7,
            },
            limit: {
              type: "number",
              description: "Maximum number of events to return (default: 20)",
              default: 20,
            },
          },
        },
      },
      {
        name: "get_daily_agenda",
        description: "Get today's agenda for working hours (9 AM - 5 PM) in the current timezone",
        inputSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Optional: specific date in ISO format (YYYY-MM-DD). Defaults to today.",
            },
            calendarName: {
              type: "string",
              description: "Optional: specific calendar name (all calendars if not specified)",
            },
            startHour: {
              type: "number",
              description: "Start hour of the workday (default: 9)",
              default: 9,
            },
            endHour: {
              type: "number",
              description: "End hour of the workday (default: 17 for 5 PM)",
              default: 17,
            },
          },
        },
      },
    ],
  });

  const callToolHandler = async (request: any) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "subscribe_calendar": {
          const { url, name: calendarName, refreshInterval = 60 } = args as any;
          await calendarManager.subscribeCalendar(url, calendarName, refreshInterval);
          return {
            content: [
              {
                type: "text",
                text: `Successfully subscribed to calendar "${calendarName}" with refresh interval of ${refreshInterval} minutes`,
              },
            ],
          };
        }

        case "list_calendars": {
          const calendars = calendarManager.listCalendars();
          return {
            content: [
              {
                type: "text",
                text: calendars.length > 0
                  ? `Subscribed calendars:\n${calendars
                      .map((cal) => `- ${cal.name} (${cal.url})`)
                      .join("\n")}`
                  : "No calendars subscribed",
              },
            ],
          };
        }

        case "unsubscribe_calendar": {
          const { name: calendarName } = args as any;
          calendarManager.unsubscribeCalendar(calendarName);
          return {
            content: [
              {
                type: "text",
                text: `Successfully unsubscribed from calendar "${calendarName}"`,
              },
            ],
          };
        }

        case "get_events": {
          const { calendarName, startDate, endDate, limit = 50 } = args as any;
          // Parse dates in local timezone, not UTC
          const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
          const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
          
          // Create dates in local timezone
          const start = new Date(startYear, startMonth - 1, startDay, 0, 0, 0, 0);
          const end = new Date(endYear, endMonth - 1, endDay, 23, 59, 59, 999);
          
          const events = await calendarManager.getEvents(
            start,
            end,
            calendarName,
            limit
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(events, null, 2),
              },
            ],
          };
        }

        case "search_events": {
          const { query, calendarName, startDate, endDate } = args as any;
          const events = await calendarManager.searchEvents(
            query,
            calendarName,
            startDate ? new Date(startDate) : undefined,
            endDate ? new Date(endDate) : undefined
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(events, null, 2),
              },
            ],
          };
        }

        case "get_upcoming_events": {
          const { calendarName, days = 7, limit = 20 } = args as any;
          const events = await calendarManager.getUpcomingEvents(
            days,
            calendarName,
            limit
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(events, null, 2),
              },
            ],
          };
        }

        case "get_daily_agenda": {
          const { date, calendarName, startHour = 9, endHour = 17 } = args as any;
          
          // Get the server's timezone
          const timezone = timezoneManager.getTimezone();
          
          // Use provided date or today
          let targetDate: Date;
          if (date) {
            // Parse the date string and interpret it in the local timezone
            const [year, month, day] = date.split('-').map(Number);
            targetDate = new Date(year, month - 1, day);
          } else {
            targetDate = new Date();
          }
          
          // Create start and end times for the working day
          const workdayStart = new Date(targetDate);
          workdayStart.setHours(startHour, 0, 0, 0);
          
          const workdayEnd = new Date(targetDate);
          workdayEnd.setHours(endHour, 0, 0, 0);
          
          // Get all events for the entire day (to catch events that might overlap)
          const dayStart = new Date(targetDate);
          dayStart.setHours(0, 0, 0, 0);
          
          const dayEnd = new Date(targetDate);
          dayEnd.setHours(23, 59, 59, 999);
          
          const allDayEvents = await calendarManager.getEvents(
            dayStart,
            dayEnd,
            calendarName
          );
          
          // Filter to only include events during working hours
          const workingHourEvents = allDayEvents.filter(event => {
            const eventStart = new Date(event.start);
            const eventEnd = new Date(event.end);
            
            // Include event if it overlaps with working hours
            return eventStart < workdayEnd && eventEnd > workdayStart;
          });
          
          // Sort by start time
          workingHourEvents.sort((a, b) => 
            new Date(a.start).getTime() - new Date(b.start).getTime()
          );
          
          // Format the response with timezone info
          const agendaInfo = {
            date: timezoneManager.formatDate(targetDate, { 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric',
              weekday: 'long'
            }),
            timezone: timezone,
            workingHours: `${startHour}:00 - ${endHour}:00`,
            totalEvents: workingHourEvents.length,
            events: workingHourEvents.map(event => ({
              ...event,
              startTime: timezoneManager.formatDate(event.start, {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              }),
              endTime: timezoneManager.formatDate(event.end, {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              })
            }))
          };
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(agendaInfo, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  };

  // Set the handlers on the server
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);

  // Add method to get request handlers for testing
  (server as any).getRequestHandlers = () => {
    const handlers = new Map();
    handlers.set("tools/list", listToolsHandler);
    handlers.set("tools/call", callToolHandler);
    return handlers;
  };

  return server;
}
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CalendarManager } from "./calendar-manager.js";
// import { TimezoneManager } from "./timezone-manager.js"; // Deprecated - use TimezoneDateManager

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
    },
  );

  // Use provided CalendarManager or create a new one
  if (!calendarManager) {
    calendarManager = new CalendarManager();
  }
  // const _timezoneManager = TimezoneManager.getInstance(); // Deprecated - CalendarManager uses TimezoneDateManager internally

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
              description:
                "Optional: specific calendar name (all calendars if not specified)",
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
              description:
                "Text to search for in event summaries and descriptions",
            },
            calendarName: {
              type: "string",
              description:
                "Optional: specific calendar name (all calendars if not specified)",
            },
            startDate: {
              type: "string",
              description:
                "Optional: start date for search range in ISO format",
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
              description:
                "Optional: specific calendar name (all calendars if not specified)",
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
        description:
          "Get today's agenda for working hours (9 AM - 5 PM) in the current timezone",
        inputSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description:
                "Optional: specific date in ISO format (YYYY-MM-DD). Defaults to today.",
            },
            calendarName: {
              type: "string",
              description:
                "Optional: specific calendar name (all calendars if not specified)",
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

  const callToolHandler = async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "subscribe_calendar": {
          const {
            url,
            name: calendarName,
            refreshInterval = 60,
          } = args as { url: string; name: string; refreshInterval?: number };
          await calendarManager.subscribeCalendar(
            url,
            calendarName,
            refreshInterval,
          );
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
                text:
                  calendars.length > 0
                    ? `Subscribed calendars:\n${calendars
                        .map((cal) => `- ${cal.name} (${cal.url})`)
                        .join("\n")}`
                    : "No calendars subscribed",
              },
            ],
          };
        }

        case "unsubscribe_calendar": {
          const { name: calendarName } = args as { name: string };
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
          const {
            calendarName,
            startDate,
            endDate,
            limit = 50,
          } = args as {
            calendarName?: string;
            startDate: string;
            endDate: string;
            limit?: number;
          };

          // Use TimezoneDateManager for proper timezone-aware date parsing
          const { TimezoneDateManager } = await import(
            "./timezone-date-manager.js"
          );
          const tzManager = new TimezoneDateManager();

          try {
            // Parse dates using Temporal for proper timezone handling
            const startZoned = tzManager.parseDate(startDate);
            const endZoned = tzManager.getEndOfDay(endDate);

            // Convert to Date objects for existing calendarManager interface
            const events = await calendarManager.getEvents(
              new Date(startZoned.epochMilliseconds),
              new Date(endZoned.epochMilliseconds),
              calendarName,
              limit,
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(events, null, 2),
                },
              ],
            };
          } catch (dateError) {
            throw new Error(
              `Invalid date format: ${dateError instanceof Error ? dateError.message : String(dateError)}`,
            );
          }
        }

        case "search_events": {
          const { query, calendarName, startDate, endDate } = args as {
            query: string;
            calendarName?: string;
            startDate?: string;
            endDate?: string;
          };

          // Use TimezoneDateManager for proper timezone-aware date parsing
          const { TimezoneDateManager } = await import(
            "./timezone-date-manager.js"
          );
          const tzManager = new TimezoneDateManager();

          try {
            // Parse optional date range using Temporal
            const start = startDate
              ? new Date(tzManager.parseDate(startDate).epochMilliseconds)
              : undefined;
            const end = endDate
              ? new Date(tzManager.getEndOfDay(endDate).epochMilliseconds)
              : undefined;

            const events = await calendarManager.searchEvents(
              query,
              calendarName,
              start,
              end,
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(events, null, 2),
                },
              ],
            };
          } catch (dateError) {
            throw new Error(
              `Invalid date format: ${dateError instanceof Error ? dateError.message : String(dateError)}`,
            );
          }
        }

        case "get_upcoming_events": {
          const {
            calendarName,
            days = 7,
            limit = 20,
          } = args as { calendarName?: string; days?: number; limit?: number };

          // Use TimezoneDateManager for proper timezone-aware date calculations
          const { TimezoneDateManager } = await import(
            "./timezone-date-manager.js"
          );
          const tzManager = new TimezoneDateManager();

          // Calculate date range using Temporal
          const now = tzManager.now();
          const endDate = now.add({ days });

          // Convert to Date objects for existing calendarManager interface
          const events = await calendarManager.getEvents(
            new Date(now.epochMilliseconds),
            new Date(endDate.epochMilliseconds),
            calendarName,
            limit,
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
          const {
            date,
            calendarName,
            startHour = 9,
            endHour = 17,
          } = args as {
            date?: string;
            calendarName?: string;
            startHour?: number;
            endHour?: number;
          };

          // Import the new timezone date manager
          const { TimezoneDateManager } = await import(
            "./timezone-date-manager.js"
          );
          const tzManager = new TimezoneDateManager();

          // Use provided date or today
          const targetDate = date || tzManager.now().toPlainDate().toString();

          // Get all events for the entire day
          const dayStart = tzManager.parseDate(targetDate);
          const dayEnd = tzManager.getEndOfDay(targetDate);

          // Convert to Date objects for existing calendarManager interface
          const allDayEvents = await calendarManager.getEvents(
            new Date(dayStart.epochMilliseconds),
            new Date(dayEnd.epochMilliseconds),
            calendarName,
          );

          // Filter events using proper timezone-aware logic
          const workingHourEvents = allDayEvents.filter((event) => {
            return tzManager.temporalEventOverlapsWorkingHours(
              event.start,
              event.end,
              targetDate,
              startHour,
              endHour,
            );
          });

          // Sort by start time (events now have Temporal objects)
          workingHourEvents.sort((a, b) =>
            Temporal.ZonedDateTime.compare(a.start, b.start),
          );

          // Format the response with proper timezone info
          const workingHours = tzManager.createWorkingHours(
            targetDate,
            startHour,
            endHour,
          );

          const agendaInfo = {
            date: tzManager.formatDate(workingHours.start, {
              year: "numeric",
              month: "long",
              day: "numeric",
              weekday: "long",
            }),
            timezone: tzManager.getTimezone(),
            workingHours: `${startHour}:00 - ${endHour}:00`,
            totalEvents: workingHourEvents.length,
            events: workingHourEvents.map((event) => {
              return {
                ...event,
                startTime: tzManager.formatTime(event.start),
                endTime: tzManager.formatTime(event.end),
              };
            }),
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
      console.error("Tool error:", error);
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
  (
    server as Server & { getRequestHandlers?: () => Map<string, unknown> }
  ).getRequestHandlers = () => {
    const handlers = new Map();
    handlers.set("tools/list", listToolsHandler);
    handlers.set("tools/call", callToolHandler);
    return handlers;
  };

  return server;
}

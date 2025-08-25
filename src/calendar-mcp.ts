import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpAgent } from 'agents/mcp';
import { KVCalendarManager } from './kv-calendar-manager.js';

// Authentication context type matching the pattern you showed
export type AuthenticationContext = {
	claims: {
		iss?: string;
		scope?: string;
		sub: string;
		aud?: string[];
		client_id?: string;
		exp?: number;
		iat?: number;
		nbf?: number;
		jti?: string;
		email?: string;
		name?: string;
	};
	accessToken: string;
};

/**
 * The CalendarMCP class exposes the Calendar Service via the Model Context Protocol
 * for consumption by AI Agents
 */
export class CalendarMCP extends McpAgent<Env, unknown, AuthenticationContext> {
	private calendarManager?: KVCalendarManager;

	async init() {
		// Initialize calendar manager with user-specific storage
		this.calendarManager = new KVCalendarManager({
			storageKey: `user:${this.props.claims.sub}:calendars`,
			env: this.env,
		});
	}

	get calendarService() {
		if (!this.calendarManager) {
			throw new Error('Calendar manager not initialized. Call init() first.');
		}
		return this.calendarManager;
	}

	formatResponse = (description: string, data?: any): {
		content: Array<{ type: 'text'; text: string }>;
	} => {
		const response = data 
			? `Success! ${description}\n\nResult:\n${JSON.stringify(data, null, 2)}`
			: `Success! ${description}`;
		
		return {
			content: [{
				type: 'text',
				text: response,
			}],
		};
	};

	get server() {
		const server = new McpServer({
			name: 'iCal MCP Server',
			version: '1.0.0',
		});

		// Calendar subscriptions resource
		server.resource(
			'Calendar Subscriptions',
			new ResourceTemplate('ical://calendars/{name}', {
				list: async () => {
					const calendars = await this.calendarService.listCalendars();
					return {
						resources: calendars.map((cal) => ({
							name: cal.name,
							uri: `ical://calendars/${encodeURIComponent(cal.name)}`,
							description: `Calendar: ${cal.name} (${cal.status})`,
						})),
					};
				},
			}),
			async (uri, params) => {
				const name = Array.isArray(params.name) ? params.name[0] : params.name;
				const calendars = await this.calendarService.listCalendars();
				const calendar = calendars.find((cal) => cal.name === decodeURIComponent(name));
				
				return {
					contents: [
						{
							uri: uri.href,
							text: calendar
								? `Calendar: ${calendar.name}\nURL: ${calendar.url}\nStatus: ${calendar.status}\nRefresh Interval: ${calendar.refreshInterval} minutes`
								: 'Calendar not found',
						},
					],
				};
			}
		);

		// Tools
		server.tool(
			'subscribe_calendar',
			'Subscribe to an iCalendar (.ics) URL',
			{
				url: z.string().url(),
				name: z.string(),
				refreshInterval: z.number().default(60),
			},
			async ({ url, name, refreshInterval = 60 }) => {
				await this.calendarService.subscribeToCalendar(url, name, refreshInterval);
				return this.formatResponse(`Successfully subscribed to calendar "${name}"`);
			}
		);

		server.tool(
			'unsubscribe_calendar',
			'Unsubscribe from a calendar',
			{
				name: z.string(),
			},
			async ({ name }) => {
				await this.calendarService.unsubscribeFromCalendar(name);
				return this.formatResponse(`Successfully unsubscribed from calendar "${name}"`);
			}
		);

		server.tool(
			'list_calendars',
			'List all subscribed calendars',
			{},
			async () => {
				const calendars = await this.calendarService.listCalendars();
				return this.formatResponse('Retrieved calendar list', { calendars });
			}
		);

		server.tool(
			'search_events',
			'Search for events across all calendars',
			{
				query: z.string(),
				calendarName: z.string().optional(),
				startDate: z.string().optional(),
				endDate: z.string().optional(),
			},
			async ({ query, calendarName, startDate, endDate }) => {
				const events = await this.calendarService.searchEvents(
					query,
					calendarName,
					startDate,
					endDate
				);
				return this.formatResponse(`Found ${events.length} matching events`, { events });
			}
		);

		server.tool(
			'get_events',
			'Get events from calendars within a date range',
			{
				startDate: z.string().optional(),
				endDate: z.string().optional(),
				calendarName: z.string().optional(),
			},
			async ({ startDate, endDate, calendarName }) => {
				const events = await this.calendarService.getEvents(startDate, endDate, calendarName);
				return this.formatResponse(
					`Retrieved ${events.length} events`,
					{ events }
				);
			}
		);

		server.tool(
			'get_daily_agenda',
			'Get daily agenda for a specific date',
			{
				date: z.string(),
				calendarName: z.string().optional(),
			},
			async ({ date, calendarName }) => {
				const events = await this.calendarService.getDailyAgenda(date, calendarName);
				return this.formatResponse(
					`Retrieved agenda for ${date}`,
					{ date, events }
				);
			}
		);

		server.tool(
			'get_upcoming_events',
			'Get upcoming events from now',
			{
				limit: z.number().default(10),
				calendarName: z.string().optional(),
			},
			async ({ limit = 10, calendarName }) => {
				const events = await this.calendarService.getUpcomingEvents(limit, calendarName);
				return this.formatResponse(
					`Retrieved ${events.length} upcoming events`,
					{ events }
				);
			}
		);

		return server;
	}
}
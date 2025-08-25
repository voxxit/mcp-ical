import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StytchAuth, UserContext, authenticateRequest, validateToolAccess, extractUserContext } from "./stytch-auth.js";
import honoApp from "./hono-worker.js";

// Environment type for Cloudflare Worker
interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  STYTCH_PROJECT_ID: string;
  STYTCH_SECRET_KEY: string;
  STYTCH_PUBLIC_TOKEN: string;
  STYTCH_PROJECT_ENV: string;
  FRONTEND_URL: string;
}

// Simple calendar cache entry
interface CalendarCache {
	name: string;
	url: string;
	refreshInterval: number;
	lastFetched: number;
	events: CalendarEvent[];
	status: "active" | "error";
	error?: string;
}

// Simplified event structure
interface CalendarEvent {
	id: string;
	summary: string;
	description?: string;
	start: string; // ISO string
	end: string; // ISO string
	location?: string;
	calendar: string;
	allDay?: boolean;
	recurring?: boolean;
}

// Session state - isolated per authenticated user
interface SessionState {
	calendars: Record<string, CalendarCache>; // keyed by calendar name
	userContext?: UserContext;
	isAuthenticated: boolean;
}

// Authentication context from Cloudflare's OAuth Provider
interface AuthContext extends Record<string, unknown> {
	claims: {
		sub: string; // User ID
		email?: string;
		name?: string;
	};
	permissions?: string[];
	accessToken?: string;
}

// Define output schemas for structured responses
const CalendarSchema = z.object({
	name: z.string(),
	url: z.string(),
	refreshInterval: z.number(),
	lastRefresh: z.string().optional(),
	status: z.enum(["active", "error", "refreshing"]),
});

const EventSchema = z.object({
	id: z.string(),
	summary: z.string(),
	description: z.string().optional(),
	start: z.string(),
	end: z.string(),
	location: z.string().optional(),
	calendar: z.string(),
	allDay: z.boolean().optional(),
	recurring: z.boolean().optional(),
});

const CalendarListSchema = z.object({
	calendars: z.array(CalendarSchema),
	total: z.number(),
});

const EventListSchema = z.object({
	events: z.array(EventSchema),
	total: z.number(),
	dateRange: z.object({
		start: z.string(),
		end: z.string(),
	}),
});

const AgendaSchema = z.object({
	date: z.string(),
	timezone: z.string(),
	workingHours: z.string(),
	totalEvents: z.number(),
	events: z.array(EventSchema.extend({
		startTime: z.string(),
		endTime: z.string(),
	})),
});

const SubscriptionResultSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	calendar: CalendarSchema.optional(),
});

const UnsubscriptionResultSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	removedCalendar: z.string().optional(),
});

export class MCP extends McpAgent<Env, SessionState, AuthContext> {
	server = new McpServer({
		name: "iCal MCP Server",
		version: "1.0.0",
	});

	// Initial state - empty calendars for this session
	initialState: SessionState = {
		calendars: {},
		isAuthenticated: false,
	};

	// Cache TTL in milliseconds (2 minutes)
	private readonly CACHE_TTL = 2 * 60 * 1000;

	// Validate tool access permissions using authentication context
	private validatePermissions(toolName: string) {
		console.log('Validating permissions for tool:', toolName, 'Props:', this.props);
		
		// For now, allow all tools to be called (authentication can be added later)
		// This ensures tools are discoverable by MCP clients
		if (!this.state.userContext) {
			const userContext: UserContext = {
				userId: this.props?.claims?.sub || 'anonymous',
				email: this.props?.claims?.email || 'anonymous@example.com',
				name: this.props?.claims?.name || 'Anonymous User',
				sessionId: 'dev-session',
				scopes: ['calendars:*', 'read:calendars', 'manage:calendars', 'read:events']
			};

			console.log('Creating user context:', userContext);

			// Update session state with user context
			this.setState({
				...this.state,
				userContext,
				isAuthenticated: true,
			});
		}

		// For development, allow all tools - in production you'd check specific permissions
		console.log('Permission granted for tool:', toolName);
		return true;
	}

	// Simple iCal parser - extracts basic event info
	private parseICalEvents(icalData: string, calendarName: string): CalendarEvent[] {
		const events: CalendarEvent[] = [];
		const lines = icalData.split(/\r?\n/);
		let currentEvent: Partial<CalendarEvent> | null = null;
		let eventId = 0;

		for (const line of lines) {
			const trimmed = line.trim();
			
			if (trimmed === 'BEGIN:VEVENT') {
				currentEvent = {
					id: `${calendarName}-${++eventId}`,
					calendar: calendarName,
				};
			} else if (trimmed === 'END:VEVENT' && currentEvent) {
				if (currentEvent.summary && currentEvent.start && currentEvent.end) {
					events.push(currentEvent as CalendarEvent);
				}
				currentEvent = null;
			} else if (currentEvent && trimmed.includes(':')) {
				const [key, ...valueParts] = trimmed.split(':');
				const value = valueParts.join(':');
				
				switch (key) {
					case 'SUMMARY':
						currentEvent.summary = value;
						break;
					case 'DESCRIPTION':
						currentEvent.description = value;
						break;
					case 'LOCATION':
						currentEvent.location = value;
						break;
					case 'DTSTART':
						currentEvent.start = this.parseICalDate(value);
						break;
					case 'DTEND':
						currentEvent.end = this.parseICalDate(value);
						break;
				}
			}
		}

		return events;
	}

	// Simple iCal date parser
	private parseICalDate(dateStr: string): string {
		// Handle basic formats: YYYYMMDDTHHMMSSZ or YYYYMMDD
		const cleaned = dateStr.replace(/[^0-9T]/g, '');
		
		if (cleaned.length === 8) {
			// YYYYMMDD format
			return `${cleaned.substring(0, 4)}-${cleaned.substring(4, 6)}-${cleaned.substring(6, 8)}`;
		} else if (cleaned.length >= 15) {
			// YYYYMMDDTHHMMSS format
			const date = cleaned.substring(0, 8);
			const time = cleaned.substring(9, 15);
			return `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}T${time.substring(0, 2)}:${time.substring(2, 4)}:${time.substring(4, 6)}Z`;
		}
		
		return new Date().toISOString(); // fallback
	}

	// Check if calendar cache is still valid
	private isCacheValid(calendar: CalendarCache): boolean {
		return (Date.now() - calendar.lastFetched) < this.CACHE_TTL;
	}

	// Fetch and cache calendar data
	private async fetchCalendar(url: string, name: string, refreshInterval: number): Promise<CalendarCache> {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			
			const icalData = await response.text();
			const events = this.parseICalEvents(icalData, name);
			
			return {
				name,
				url,
				refreshInterval,
				lastFetched: Date.now(),
				events,
				status: "active",
			};
		} catch (error) {
			return {
				name,
				url,
				refreshInterval,
				lastFetched: Date.now(),
				events: [],
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// Get calendar from cache or fetch if needed
	private async getCalendar(name: string): Promise<CalendarCache | null> {
		const cached = this.state.calendars[name];
		if (!cached) return null;
		
		if (this.isCacheValid(cached)) {
			return cached;
		}
		
		// Cache expired, refetch
		const fresh = await this.fetchCalendar(cached.url, cached.name, cached.refreshInterval);
		this.setState({
			...this.state,
			calendars: {
				...this.state.calendars,
				[name]: fresh,
			},
		});
		
		return fresh;
	}

	// Filter events by date range
	private filterEventsByDateRange(events: CalendarEvent[], startDate: string, endDate: string): CalendarEvent[] {
		const start = new Date(startDate);
		const end = new Date(endDate);
		end.setHours(23, 59, 59, 999); // Include entire end date
		
		return events.filter(event => {
			const eventStart = new Date(event.start);
			const eventEnd = new Date(event.end);
			
			// Event overlaps with date range
			return eventStart <= end && eventEnd >= start;
		});
	}

	// Search events by query text
	private searchEvents(events: CalendarEvent[], query: string): CalendarEvent[] {
		const lowerQuery = query.toLowerCase();
		return events.filter(event => 
			event.summary.toLowerCase().includes(lowerQuery) ||
			(event.description && event.description.toLowerCase().includes(lowerQuery)) ||
			(event.location && event.location.toLowerCase().includes(lowerQuery))
		);
	}

	// Get all events from specified calendars
	private async getAllEvents(calendarName?: string): Promise<CalendarEvent[]> {
		const calendarsToCheck = calendarName 
			? [calendarName]
			: Object.keys(this.state.calendars);
		
		const allEvents: CalendarEvent[] = [];
		
		for (const name of calendarsToCheck) {
			const calendar = await this.getCalendar(name);
			if (calendar && calendar.status === "active") {
				allEvents.push(...calendar.events);
			}
		}
		
		// Sort by start time
		return allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
	}

	async init() {
		console.log('MCP server initializing...');
		console.log('Authentication context:', this.props);
		console.log('Initial state:', this.state);
		
		// 1. Subscribe to calendar tool
		console.log('Registering subscribe_calendar tool');
		this.server.tool(
			"subscribe_calendar",
			"Subscribe to an iCal calendar",
			{
				url: z.string().describe("The iCal feed URL"),
				name: z.string().describe("A unique name for this calendar"),
				refreshInterval: z.number().default(60).describe("Refresh interval in minutes"),
			},
			async ({ url, name, refreshInterval = 60 }) => {
				try {
					// Validate permissions
					this.validatePermissions('subscribe_calendar');
					// Validate URL
					new URL(url); // throws if invalid
					
					// Check if calendar already exists
					if (this.state.calendars[name]) {
						throw new Error(`Calendar "${name}" already exists. Use a different name or unsubscribe first.`);
					}
					
					// Fetch calendar data
					const calendar = await this.fetchCalendar(url, name, refreshInterval);
					
					// Store in session state
					this.setState({
						...this.state,
						calendars: {
							...this.state.calendars,
							[name]: calendar,
						},
					});
					
					const result = {
						success: calendar.status === "active",
						message: calendar.status === "active" 
							? `Successfully subscribed to calendar "${name}" with ${calendar.events.length} events`
							: `Failed to fetch calendar "${name}": ${calendar.error}`,
						calendar: {
							name: calendar.name,
							url: calendar.url,
							refreshInterval: calendar.refreshInterval,
							status: calendar.status,
							lastRefresh: new Date(calendar.lastFetched).toISOString(),
						},
					};
					
					return {
						content: [{ type: "text", text: result.message }],
						structuredContent: result,
						isError: calendar.status === "error",
					};
				} catch (error) {
					const result = {
						success: false,
						message: `Failed to subscribe to calendar: ${error instanceof Error ? error.message : String(error)}`,
					};
					return {
						content: [{ type: "text", text: result.message }],
						structuredContent: result,
						isError: true,
					};
				}
			},
		);

		// 2. List calendars tool
		console.log('Registering list_calendars tool');
		this.server.tool(
			"list_calendars",
			"List all subscribed calendars",
			{},
			async () => {
				// Validate permissions
				this.validatePermissions('list_calendars');
				const calendars = Object.values(this.state.calendars).map(cal => ({
					name: cal.name,
					url: cal.url,
					refreshInterval: cal.refreshInterval,
					status: cal.status,
					lastRefresh: new Date(cal.lastFetched).toISOString(),
					eventCount: cal.events.length,
					error: cal.error,
				}));
				
				const result = {
					calendars,
					total: calendars.length,
				};
				
				return {
					content: [{ type: "text", text: `Found ${result.total} calendars in this session` }],
					structuredContent: result,
				};
			},
		);

		// 3. Unsubscribe calendar tool
		console.log('Registering unsubscribe_calendar tool');
		this.server.tool(
			"unsubscribe_calendar",
			"Unsubscribe from a calendar",
			{
				name: z.string().describe("Name of the calendar to unsubscribe from"),
			},
			async ({ name }) => {
				try {
					// Validate permissions
					this.validatePermissions('unsubscribe_calendar');
					if (!this.state.calendars[name]) {
						throw new Error(`Calendar "${name}" not found`);
					}
					
					// Remove from session state
					const { [name]: removed, ...remaining } = this.state.calendars;
					this.setState({
						...this.state,
						calendars: remaining,
					});
					
					const result = {
						success: true,
						message: `Successfully unsubscribed from calendar "${name}"`,
						removedCalendar: name,
					};
					return {
						content: [{ type: "text", text: result.message }],
						structuredContent: result,
					};
				} catch (error) {
					const result = {
						success: false,
						message: `Failed to unsubscribe from calendar: ${error instanceof Error ? error.message : String(error)}`,
					};
					return {
						content: [{ type: "text", text: result.message }],
						structuredContent: result,
						isError: true,
					};
				}
			},
		);

		// 4. Get events tool
		console.log('Registering get_events tool');
		this.server.tool(
			"get_events",
			"Get events within a date range",
			{
				startDate: z.string().describe("Start date in YYYY-MM-DD format"),
				endDate: z.string().describe("End date in YYYY-MM-DD format"),
				calendarName: z.string().optional().describe("Optional: specific calendar name to filter by"),
				limit: z.number().default(50).describe("Maximum number of events to return"),
			},
			async ({ startDate, endDate, calendarName, limit = 50 }) => {
				try {
					// Validate permissions
					this.validatePermissions('get_events');
					// Get all events from specified calendars
					const allEvents = await this.getAllEvents(calendarName);
					
					// Filter by date range
					const filteredEvents = this.filterEventsByDateRange(allEvents, startDate, endDate);
					
					// Apply limit
					const limitedEvents = filteredEvents.slice(0, limit);
					
					const result = {
						events: limitedEvents,
						total: limitedEvents.length,
						dateRange: {
							start: startDate,
							end: endDate,
						},
					};
					
					const calendarText = calendarName ? ` from calendar "${calendarName}"` : " from all calendars";
					return {
						content: [{ type: "text", text: `Found ${result.total} events${calendarText} from ${startDate} to ${endDate}` }],
						structuredContent: result,
					};
				} catch (error) {
					return {
						content: [{
							type: "text" as const,
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						}],
						isError: true,
					};
				}
			},
		);

		// 5. Search events tool
		console.log('Registering search_events tool');
		this.server.tool(
			"search_events",
			"Search for events by text query",
			{
				query: z.string().describe("Search term to match in event title, description, or location"),
				calendarName: z.string().optional().describe("Optional: specific calendar name to search within"),
				startDate: z.string().optional().describe("Optional: start date filter in YYYY-MM-DD format"),
				endDate: z.string().optional().describe("Optional: end date filter in YYYY-MM-DD format"),
			},
			async ({ query, calendarName, startDate, endDate }) => {
				try {
					// Validate permissions
					this.validatePermissions('search_events');
					// Get all events from specified calendars
					let allEvents = await this.getAllEvents(calendarName);
					
					// Filter by date range if provided
					if (startDate && endDate) {
						allEvents = this.filterEventsByDateRange(allEvents, startDate, endDate);
					}
					
					// Search by query
					const searchResults = this.searchEvents(allEvents, query);
					
					const result = {
						events: searchResults,
						total: searchResults.length,
						dateRange: {
							start: startDate || "N/A",
							end: endDate || "N/A",
						},
					};
					
					const calendarText = calendarName ? ` in calendar "${calendarName}"` : " in all calendars";
					const dateText = startDate && endDate ? ` between ${startDate} and ${endDate}` : "";
					return {
						content: [{ type: "text", text: `Found ${result.total} events matching "${query}"${calendarText}${dateText}` }],
						structuredContent: result,
					};
				} catch (error) {
					return {
						content: [{
							type: "text" as const,
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						}],
						isError: true,
					};
				}
			},
		);

		// 6. Get upcoming events tool
		console.log('Registering get_upcoming_events tool');
		this.server.tool(
			"get_upcoming_events",
			"Get upcoming events from now",
			{
				calendarName: z.string().optional().describe("Optional: specific calendar name to filter by"),
				days: z.number().default(7).describe("Number of days to look ahead"),
				limit: z.number().default(20).describe("Maximum number of events to return"),
			},
			async ({ calendarName, days = 7, limit = 20 }) => {
				try {
					// Validate permissions
					this.validatePermissions('get_upcoming_events');
					const now = new Date();
					const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
					
					// Get all events and filter for upcoming
					const allEvents = await this.getAllEvents(calendarName);
					const upcomingEvents = this.filterEventsByDateRange(
						allEvents, 
						now.toISOString().split('T')[0], 
						endDate.toISOString().split('T')[0]
					).slice(0, limit);
					
					const result = {
						events: upcomingEvents,
						total: upcomingEvents.length,
						dateRange: {
							start: now.toISOString().split('T')[0],
							end: endDate.toISOString().split('T')[0],
						},
					};
					
					const calendarText = calendarName ? ` from calendar "${calendarName}"` : " from all calendars";
					return {
						content: [{ type: "text", text: `Found ${result.total} upcoming events${calendarText} in the next ${days} days` }],
						structuredContent: result,
					};
				} catch (error) {
					return {
						content: [{
							type: "text" as const,
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						}],
						isError: true,
					};
				}
			},
		);

		// 7. Get daily agenda tool
		console.log('Registering get_daily_agenda tool');
		this.server.tool(
			"get_daily_agenda",
			"Get a daily agenda view for a specific date",
			{
				date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
				calendarName: z.string().optional().describe("Optional: specific calendar name to filter by"),
				startHour: z.number().default(9).describe("Working hours start (24-hour format)"),
				endHour: z.number().default(17).describe("Working hours end (24-hour format)"),
			},
			async ({ date, calendarName, startHour = 9, endHour = 17 }) => {
				try {
					// Validate permissions
					this.validatePermissions('get_daily_agenda');
					const targetDate = date || new Date().toISOString().split('T')[0];
					const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
					
					// Get events for the target date
					const allEvents = await this.getAllEvents(calendarName);
					const dayEvents = this.filterEventsByDateRange(allEvents, targetDate, targetDate);
					
					// Filter events within working hours and add time formatting
					const workingHourEvents = dayEvents
						.filter(event => {
							const eventStart = new Date(event.start);
							const eventHour = eventStart.getHours();
							return eventHour >= startHour && eventHour < endHour;
						})
						.map(event => ({
							...event,
							startTime: new Date(event.start).toLocaleTimeString('en-US', { 
								hour: '2-digit', 
								minute: '2-digit',
								timeZone: timezone 
							}),
							endTime: new Date(event.end).toLocaleTimeString('en-US', { 
								hour: '2-digit', 
								minute: '2-digit',
								timeZone: timezone 
							}),
						}));
					
					const result = {
						date: targetDate,
						timezone,
						workingHours: `${startHour}:00 - ${endHour}:00`,
						totalEvents: workingHourEvents.length,
						events: workingHourEvents,
					};
					
					const calendarText = calendarName ? ` from calendar "${calendarName}"` : " from all calendars";
					return {
						content: [{ type: "text", text: `Daily agenda for ${targetDate}: ${result.totalEvents} events during working hours (${result.workingHours})${calendarText}` }],
						structuredContent: result,
					};
				} catch (error) {
					return {
						content: [{
							type: "text" as const,
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						}],
						isError: true,
					};
				}
			},
		);
		
		console.log('MCP server initialization complete - all 7 tools registered');
	}
}

// Create HTTP handler with OAuth endpoints and MCP server
function createHandler(env: Env) {
	// Initialize Stytch with environment variables from Cloudflare secrets
	// Use your actual project details as fallbacks for development
	const projectId = env.STYTCH_PROJECT_ID || 'project-test-859ee12c-e49d-4fb1-883c-6fd620672627';
	const publicToken = env.STYTCH_PUBLIC_TOKEN || 'public-token-test-4f2fd0b0-9b4f-441e-9d4f-22fe3b23f3fc';
	
	if (!env.STYTCH_SECRET_KEY) {
		throw new Error('Missing required STYTCH_SECRET_KEY. Set it using: wrangler secret put STYTCH_SECRET_KEY');
	}

	StytchAuth.initialize(
		projectId,
		env.STYTCH_SECRET_KEY,
		publicToken,
		(env.STYTCH_PROJECT_ENV as 'test' | 'live') || 'test'
	);

	return async function handler(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+/g, '/'); // Normalize multiple slashes

		// Debug logging for all requests
		console.log(`Request: ${request.method} ${path}`, {
			search: url.search,
			params: Object.fromEntries(new URLSearchParams(url.search).entries())
		});

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 200,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
				},
			});
		}

		// OAuth Protected Resource Metadata endpoint (RFC 8705)
		if (path === '/.well-known/oauth-protected-resource') {
			const baseUrl = `${url.protocol}//${url.host}`;
			const metadata = {
				resource: baseUrl,
				authorization_servers: [env.STYTCH_PROJECT_ENV === 'live' ? 'https://api.stytch.com' : 'https://login-test.srv.im'],
				scopes_supported: ['read:calendars', 'manage:calendars', 'read:events', 'calendars:*', 'openid', 'profile', 'email'],
				bearer_methods_supported: ['header'],
			};
			
			return new Response(JSON.stringify(metadata), {
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// OAuth Authorization Server Metadata endpoint (RFC 8414)
		if (path === '/.well-known/oauth-authorization-server') {
			const baseUrl = `${url.protocol}//${url.host}`;
			const metadata = StytchAuth.getAuthorizationServerMetadata(baseUrl);
			
			return new Response(JSON.stringify(metadata), {
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// OpenID Configuration endpoint (OIDC Discovery)
		if (path === '/.well-known/openid-configuration') {
			const baseUrl = `${url.protocol}//${url.host}`;
			const metadata = StytchAuth.getAuthorizationServerMetadata(baseUrl);
			
			// Add OpenID-specific fields
			const oidcMetadata = {
				...metadata,
				userinfo_endpoint: `${env.STYTCH_PROJECT_ENV === 'live' ? 'https://api.stytch.com' : 'https://login-test.srv.im'}/v1/sessions/authenticate`,
			};
			
			return new Response(JSON.stringify(oidcMetadata), {
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// OAuth2 Token endpoint - handles authorization code exchange
		if (path === '/oauth2/token' && request.method === 'POST') {
			try {
				const body = await request.text();
				const tokenParams = new URLSearchParams(body);
				
				const grantType = tokenParams.get('grant_type');
				const code = tokenParams.get('code');
				const clientId = tokenParams.get('client_id');
				const codeVerifier = tokenParams.get('code_verifier');
				
				if (grantType !== 'authorization_code') {
					return new Response(JSON.stringify({
						error: 'unsupported_grant_type',
						error_description: 'Only authorization_code grant type is supported'
					}), {
						status: 400,
						headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
					});
				}
				
				if (!code || !clientId || !codeVerifier) {
					return new Response(JSON.stringify({
						error: 'invalid_request',
						error_description: 'Missing required parameters: code, client_id, code_verifier'
					}), {
						status: 400,
						headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
					});
				}
				
				// Decode the authorization code (in production, look this up from KV/DB)
				let codeData;
				try {
					codeData = JSON.parse(atob(code));
				} catch (e) {
					return new Response(JSON.stringify({
						error: 'invalid_grant',
						error_description: 'Invalid authorization code'
					}), {
						status: 400,
						headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
					});
				}
				
				// Skip PKCE verification since Stytch has already handled it in their OAuth flow
				// When using Stytch's /v1/public/oauth/github/start, PKCE is automatically managed by Stytch
				console.log('Using Stytch OAuth - PKCE verification handled by Stytch');
				
				// Get user info from the stored authorization code data
				let userContext: UserContext;
				if (codeData.userContext) {
					// Use the pre-authenticated user context from the authorization code
					userContext = codeData.userContext as UserContext;
				} else {
					// Fallback: try to authenticate the token (for backwards compatibility)
					try {
						if (codeData.type === 'oauth') {
							const response = await StytchAuth.getClient().oauth.authenticate({
								token: codeData.token,
								// Set session duration for OAuth flow (24 hours)
								session_duration_minutes: 1440,
							});
							userContext = extractUserContext(response);
						} else if (codeData.type === 'magic_links') {
							const response = await StytchAuth.getClient().magicLinks.authenticate({
								token: codeData.token,
								// Set session duration for OAuth flow (24 hours)
								session_duration_minutes: 1440,
							});
							userContext = extractUserContext(response);
						} else {
							const response = await StytchAuth.verifySession(codeData.token);
							userContext = extractUserContext(response);
						}
					} catch (error) {
						console.error('Token verification failed:', error);
						return new Response(JSON.stringify({
							error: 'invalid_grant',
							error_description: `Failed to verify authentication token: ${error instanceof Error ? error.message : 'Unknown error'}`
						}), {
							status: 400,
							headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
						});
					}
				}
				
				// Extract the Stytch session JWT from the authorization code
				const sessionJWT = codeData.sessionJWT;
				
				if (!sessionJWT) {
					return new Response(JSON.stringify({
						error: 'server_error',
						error_description: 'Session JWT not found in authorization code'
					}), {
						status: 500,
						headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
					});
				}
				
				// Return the Stytch JWT as the access token
				return new Response(JSON.stringify({
					access_token: sessionJWT,
					token_type: 'Bearer',
					expires_in: 86400, // 24 hours (matches our session duration)
					scope: codeData.scope || 'read:calendars manage:calendars read:events',
					// Include user info for MCP client
					user_id: userContext.userId,
					email: userContext.email,
					name: userContext.name
				}), {
					headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
				});
				
			} catch (error) {
				return new Response(JSON.stringify({
					error: 'server_error',
					error_description: 'Internal server error during token exchange'
				}), {
					status: 500,
					headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
				});
			}
		}

		// OAuth2 Register endpoint - proxy to Stytch
		if (path === '/oauth2/register' && request.method === 'POST') {
			const stytchBaseUrl = env.STYTCH_PROJECT_ENV === 'live' ? 'https://api.stytch.com' : 'https://login-test.srv.im';
			const stytchUrl = `${stytchBaseUrl}/v1/oauth2/register`;
			
			// Forward the request to Stytch
			const response = await fetch(stytchUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: await request.text(),
			});
			
			return new Response(await response.text(), {
				status: response.status,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// JWKS endpoint - proxy to Stytch
		if (path === '/.well-known/jwks.json' && request.method === 'GET') {
			const stytchBaseUrl = env.STYTCH_PROJECT_ENV === 'live' ? 'https://api.stytch.com' : 'https://login-test.srv.im';
			const stytchUrl = `${stytchBaseUrl}/v1/sessions/jwks/${projectId}`;
			
			// Forward the request to Stytch
			const response = await fetch(stytchUrl, {
				method: 'GET',
			});
			
			return new Response(await response.text(), {
				status: response.status,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// OAuth Authorization endpoint - implements OAuth 2.1 authorization code flow
		if (path === '/oauth/authorize' && request.method === 'GET') {
			const params = new URLSearchParams(url.search);
			const clientId = params.get('client_id');
			const redirectUri = params.get('redirect_uri');
			const state = params.get('state');
			const scope = params.get('scope');
			const codeChallenge = params.get('code_challenge');
			const codeChallengeMethod = params.get('code_challenge_method');
			const responseType = params.get('response_type');
			
			// Debug logging to help identify the issue
			console.log('OAuth authorize request:', {
				url: request.url,
				params: Object.fromEntries(params.entries()),
				clientId,
				redirectUri,
				responseType,
				codeChallenge,
				codeChallengeMethod
			});
			
			// Validate required OAuth 2.1 parameters
			if (!clientId || !redirectUri || responseType !== 'code') {
				// If redirect_uri is missing, we can't redirect back, so return error page
				if (!redirectUri) {
					return new Response(`
						<!DOCTYPE html>
						<html>
						<head><title>OAuth Error</title></head>
						<body>
							<h2>OAuth Error: invalid_request</h2>
							<p>Missing or invalid required parameters: client_id, redirect_uri, and response_type=code</p>
							<p>Please check your OAuth configuration and try again.</p>
						</body>
						</html>
					`, {
						status: 400,
						headers: { 'Content-Type': 'text/html' }
					});
				}
				
				const errorParams = new URLSearchParams({
					error: 'invalid_request',
					error_description: 'Missing or invalid required parameters: client_id, redirect_uri, and response_type=code',
				});
				if (state) errorParams.set('state', state);
				
				return Response.redirect(`${redirectUri}?${errorParams.toString()}`, 302);
			}

			// PKCE is required for OAuth 2.1
			if (!codeChallenge || codeChallengeMethod !== 'S256') {
				const errorParams = new URLSearchParams({
					error: 'invalid_request',
					error_description: 'PKCE is required. Missing code_challenge or code_challenge_method must be S256',
				});
				if (state) errorParams.set('state', state);
				
				return Response.redirect(`${redirectUri}?${errorParams.toString()}`, 302);
			}

			// Store authorization request details in KV with expiration
			const authRequestId = `auth_${Date.now()}_${Math.random().toString(36).substring(2)}`;
			
			// Store auth request parameters in KV (expires in 10 minutes)
			// Note: This code is deprecated - we now use Hono app for OAuth handling
			// await env.AUTH_STORE.put(`auth_request:${authRequestId}`, JSON.stringify({
			//	clientId,
			//	redirectUri,
			//	scope,
			//	state,
			//	codeChallenge,
			//	codeChallengeMethod,
			//	createdAt: Date.now()
			// }), { expirationTtl: 600 }); // 10 minutes
			
			// Return a login form that will authenticate with Stytch and then redirect back to complete the flow
			const loginPage = `
			<!DOCTYPE html>
			<html>
			<head>
				<title>iCal MCP Server - Authorization</title>
				<style>
					body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #f5f5f5; }
					.container { background: white; padding: 40px; border-radius: 8px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
					.logo { color: #1976d2; margin-bottom: 20px; }
					.app-info { background: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0; text-align: left; }
					.scopes { margin: 15px 0; }
					.scope-item { background: #e3f2fd; padding: 8px 12px; margin: 5px; display: inline-block; border-radius: 20px; font-size: 14px; }
				</style>
				<script src="https://js.stytch.com/stytch.js"></script>
			</head>
			<body>
				<div class="container">
					<h1 class="logo">🗓️ iCal MCP Server</h1>
					<div class="app-info">
						<h3>Authorization Request</h3>
						<p><strong>Application:</strong> ${clientId}</p>
						<p><strong>Redirect URI:</strong> ${redirectUri}</p>
						${scope ? `
						<p><strong>Requested Permissions:</strong></p>
						<div class="scopes">
							${scope.split(' ').map(s => `<span class="scope-item">${s}</span>`).join('')}
						</div>
						` : ''}
					</div>
					<p>Please log in to authorize this application to access your calendar data</p>
					<div id="stytch-sdk"></div>
				</div>
				<script>
					// OAuth params are already stored in KV under authRequestId
					window.authRequestId = '${authRequestId}';

					// Wait for Stytch SDK to load
					const initializeStytch = () => {
						if (window.Stytch) {
							// Stytch GitHub OAuth login button
							document.getElementById('stytch-sdk').innerHTML = \`
								<div style="text-align: center; padding: 20px;">
									<button id="github-login-btn" style="
										background: #24292e; 
										color: white; 
										border: none; 
										padding: 12px 24px; 
										border-radius: 6px; 
										font-size: 16px; 
										cursor: pointer;
										display: flex;
										align-items: center;
										gap: 8px;
										margin: 0 auto;
									">
										<svg height="16" width="16" viewBox="0 0 16 16" fill="white">
											<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
										</svg>
										Continue with GitHub
									</button>
								</div>
							\`;
							
							document.getElementById('github-login-btn').addEventListener('click', () => {
								// Use authRequestId from window object (stored in KV)
								const authRequestId = window.authRequestId;
								
								// Use Stytch's GitHub OAuth start endpoint with authRequestId in redirect URLs
								const stytchGitHubUrl = '${env.STYTCH_PROJECT_ENV === 'live' ? 'https://stytch.com' : 'https://login-test.srv.im'}/v1/public/oauth/github/start?' + new URLSearchParams({
									public_token: '${publicToken}',
									login_redirect_url: '${url.origin}/oauth/complete?auth_request_id=' + authRequestId,
									signup_redirect_url: '${url.origin}/oauth/complete?auth_request_id=' + authRequestId
								}).toString();
								
								window.location.href = stytchGitHubUrl;
							});
						} else {
							// Retry after a short delay if Stytch hasn't loaded yet
							setTimeout(initializeStytch, 100);
						}
					};

					initializeStytch();
				</script>
			</body>
			</html>`;

			return new Response(loginPage, {
				headers: {
					'Content-Type': 'text/html',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// OAuth Complete endpoint - handles Stytch OAuth completion  
		if (path === '/oauth/complete' && request.method === 'GET') {
			const params = new URLSearchParams(url.search);
			const stytchToken = params.get('stytch_token') || params.get('token');
			const stytchTokenType = params.get('stytch_token_type');
			const error = params.get('error');

			if (error) {
				return new Response(`
				<!DOCTYPE html>
				<html>
				<head><title>Authentication Error</title></head>
				<body>
					<h2>Authentication Failed</h2>
					<p>Error: ${error}</p>
					<script>
						// Try to get OAuth params from sessionStorage
						const oauthParams = JSON.parse(sessionStorage.getItem('oauthParams') || '{}');
						if (oauthParams.redirectUri) {
							const errorParams = new URLSearchParams({
								error: 'access_denied',
								error_description: 'User authentication failed',
								state: oauthParams.state || ''
							});
							window.location.href = oauthParams.redirectUri + '?' + errorParams.toString();
						}
					</script>
				</body>
				</html>`, {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			if (!stytchToken) {
				return new Response(`
				<!DOCTYPE html>
				<html>
				<head><title>Authentication Error</title></head>
				<body>
					<h2>No Authentication Token</h2>
					<script>
						const oauthParams = JSON.parse(sessionStorage.getItem('oauthParams') || '{}');
						if (oauthParams.redirectUri) {
							const errorParams = new URLSearchParams({
								error: 'access_denied',
								error_description: 'No authentication token received',
								state: oauthParams.state || ''
							});
							window.location.href = oauthParams.redirectUri + '?' + errorParams.toString();
						}
					</script>
				</body>
				</html>`, {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			try {
				// Authenticate with Stytch OAuth token
				let userContext: UserContext;
				const response = await StytchAuth.getClient().oauth.authenticate({
					token: stytchToken,
					// Set session duration for 24 hours
					session_duration_minutes: 1440,
				});
				userContext = extractUserContext(response);
				const sessionJWT = response.session_jwt;

				// Success - generate authorization code and redirect back to MCP client
				const successPage = `
				<!DOCTYPE html>
				<html>
				<head><title>Authorization Complete</title></head>
				<body>
					<h2>Authorization Successful</h2>
					<p>Redirecting back to your application...</p>
					<script>
						const oauthParams = JSON.parse(sessionStorage.getItem('oauthParams') || '{}');
						if (oauthParams.redirectUri) {
							// Generate authorization code (in production, store this mapping in KV/DB)
							const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substring(2);
							
							// Store the mapping: authCode -> { userContext, clientId, scope, codeChallenge, sessionJWT }
							const codeData = {
								userContext: {
									userId: '${userContext.userId}',
									email: '${userContext.email}',
									name: '${userContext.name || ''}',
									sessionId: '${userContext.sessionId}',
									scopes: ${JSON.stringify(userContext.scopes)}
								},
								sessionJWT: ${JSON.stringify(sessionJWT)},
								type: 'oauth',
								client: oauthParams.clientId,
								challenge: oauthParams.codeChallenge,
								scope: oauthParams.scope
							};
							const encodedCode = btoa(JSON.stringify(codeData));
							
							const successParams = new URLSearchParams({
								code: encodedCode,
								state: oauthParams.state || ''
							});
							
							window.location.href = oauthParams.redirectUri + '?' + successParams.toString();
						} else {
							document.body.innerHTML = '<h2>Success!</h2><p>GitHub authentication completed. You can close this tab.</p>';
						}
					</script>
				</body>
				</html>`;

				return new Response(successPage, {
					headers: { 'Content-Type': 'text/html' },
				});
			} catch (error) {
				console.error('OAuth token verification failed:', error);
				const errorPage = `
				<!DOCTYPE html>
				<html>
				<head><title>Authentication Failed</title></head>
				<body>
					<div style="text-align: center; padding: 40px;">
						<h2>Authentication Failed</h2>
						<p>Unable to verify your GitHub authentication token</p>
						<p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
						<p>Close this tab and try again.</p>
					</div>
				</body>
				</html>`;

				return new Response(errorPage, {
					status: 400,
					headers: { 'Content-Type': 'text/html' },
				});
			}
		}

		// OAuth Callback endpoint - legacy endpoint for backward compatibility
		if (path === '/oauth/callback' || path.startsWith('/oauth/callback/')) {
			const params = new URLSearchParams(url.search);
			const stytchToken = params.get('stytch_token');
			const stytchTokenType = params.get('stytch_token_type');
			const error = params.get('error');
			const errorDescription = params.get('error_description');

			if (error) {
				// Handle OAuth error
				const errorPage = `
				<!DOCTYPE html>
				<html>
				<head>
					<title>OAuth Error</title>
					<style>
						body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
						.error { color: #d32f2f; background: #ffebee; padding: 20px; border-radius: 8px; }
					</style>
				</head>
				<body>
					<div class="error">
						<h2>OAuth Error: ${error}</h2>
						<p>${errorDescription || 'An error occurred during authentication'}</p>
						<p>Close this tab and try again.</p>
					</div>
				</body>
				</html>`;

				return new Response(errorPage, {
					status: 400,
					headers: {
						'Content-Type': 'text/html',
						'Access-Control-Allow-Origin': '*',
					},
				});
			}

			if (!stytchToken) {
				// No token found - display error message
				const errorPage = `
				<!DOCTYPE html>
				<html>
				<head>
					<title>OAuth Callback</title>
					<style>
						body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
						.error { color: #d32f2f; background: #ffebee; padding: 20px; border-radius: 8px; }
					</style>
				</head>
				<body>
					<div class="error">
						<h2>Authentication Error: invalid_request</h2>
						<p>Missing authentication token in response</p>
						<p>Close this tab and try again.</p>
					</div>
				</body>
				</html>`;

				return new Response(errorPage, {
					status: 400,
					headers: {
						'Content-Type': 'text/html',
						'Access-Control-Allow-Origin': '*',
					},
				});
			}

			try {
				// Verify the Stytch token and get user information
				let userContext: UserContext;
				let sessionJWT: string;
				
				if (stytchTokenType === 'magic_links') {
					const response = await StytchAuth.getClient().magicLinks.authenticate({
						token: stytchToken,
						// Set session duration for 24 hours
						session_duration_minutes: 1440,
					});
					userContext = extractUserContext(response);
					sessionJWT = response.session_jwt;
				} else {
					// For OAuth tokens, use oauth.authenticate() to get JWT
					const response = await StytchAuth.getClient().oauth.authenticate({
						token: stytchToken,
						session_duration_minutes: 1440,
					});
					userContext = extractUserContext(response);
					sessionJWT = response.session_jwt;
				}

				// Generate an authorization code for the MCP inspector
				// In a real implementation, you'd store this mapping in your database
				const authCode = `auth_${Date.now()}_${Math.random().toString(36).substring(2)}`;

				// Success - display the authorization code for the MCP inspector
				const successPage = `
				<!DOCTYPE html>
				<html>
				<head>
					<title>OAuth Success</title>
					<style>
						body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
						.success { color: #2e7d32; background: #e8f5e8; padding: 20px; border-radius: 8px; }
						.code { background: #f5f5f5; padding: 10px; border: 1px solid #ddd; border-radius: 4px; 
							    font-family: monospace; margin: 10px 0; word-break: break-all; }
						button { background: #1976d2; color: white; border: none; padding: 10px 20px; 
							    border-radius: 4px; cursor: pointer; font-size: 16px; }
						button:hover { background: #1565c0; }
						.user-info { text-align: left; background: #f9f9f9; padding: 15px; border-radius: 4px; margin: 10px 0; }
					</style>
					<script>
						function copyCode() {
							const codeElement = document.getElementById('auth-code');
							navigator.clipboard.writeText(codeElement.textContent).then(() => {
								document.getElementById('copy-btn').textContent = 'Copied!';
								setTimeout(() => {
									document.getElementById('copy-btn').textContent = 'Copy Code';
								}, 2000);
							});
						}
					</script>
				</head>
				<body>
					<div class="success">
						<h2>Authentication Successful!</h2>
						<div class="user-info">
							<strong>Authenticated as:</strong> ${userContext.email}<br>
							${userContext.name ? `<strong>Name:</strong> ${userContext.name}<br>` : ''}
							<strong>User ID:</strong> ${userContext.userId}<br>
							<strong>Scopes:</strong> ${userContext.scopes.join(', ') || 'default'}
						</div>
						<p>Please copy this authorization code and return to the Auth Debugger:</p>
						<div class="code" id="auth-code">${authCode}</div>
						<button id="copy-btn" onclick="copyCode()">Copy Code</button>
						<p><small>Close this tab and paste the code in the OAuth flow to complete authentication.</small></p>
					</div>
				</body>
				</html>`;

				return new Response(successPage, {
					headers: {
						'Content-Type': 'text/html',
						'Access-Control-Allow-Origin': '*',
					},
				});
			} catch (error) {
				console.error('Token verification failed:', error);
				const errorPage = `
				<!DOCTYPE html>
				<html>
				<head>
					<title>Authentication Failed</title>
					<style>
						body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
						.error { color: #d32f2f; background: #ffebee; padding: 20px; border-radius: 8px; }
					</style>
				</head>
				<body>
					<div class="error">
						<h2>Authentication Failed</h2>
						<p>Unable to verify your authentication token</p>
						<p>Close this tab and try again.</p>
					</div>
				</body>
				</html>`;

				return new Response(errorPage, {
					status: 400,
					headers: {
						'Content-Type': 'text/html',
						'Access-Control-Allow-Origin': '*',
					},
				});
			}
		}

		// Default response for other paths
		return new Response('iCal MCP Server with Stytch Authentication', {
			headers: {
				'Content-Type': 'text/plain',
				'Access-Control-Allow-Origin': '*',
			},
		});
	};
}

// Export the MCP handler as the main Durable Object class
export { MCP };

// Create and export the combined handler
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle MCP SSE requests via the Durable Object
		if (url.pathname === '/sse' || url.pathname === '/mcp') {
			// Get user-specific MCP Durable Object instance
			const userId = 'anonymous'; // This will be replaced by proper auth in production
			const id = env.MCP_OBJECT.idFromName(`mcp:${userId}`);
			const stub = env.MCP_OBJECT.get(id);
			
			// Forward the request to the Durable Object
			return await stub.fetch(request, env, ctx);
		}
		
		// All other requests go to Hono app for OAuth/web dashboard
		return honoApp.fetch(request, env, ctx);
	}
};
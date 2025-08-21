import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClerkHandler } from "./clerk-auth.js";

// Extend the Env interface to include secrets and config
interface Env extends Cloudflare.Env {
  CLERK_SECRET_KEY: string;
}

interface CalendarSubscription {
  id: string;
  url: string;
  name: string;
  refreshInterval: number;
  lastUpdated?: string;
  userId: string;
}

// MCP Agent for authenticated iCal with SQLite support
export class ICalMCPSQLite extends McpAgent {
  server = new McpServer({
    name: "iCal MCP Server",
    version: "3.0.0",
  });

  private kv: KVNamespace;
  private userId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.kv = env.CALENDAR_CACHE;
  }

  async init() {
    // Subscribe to a calendar
    this.server.tool(
      "subscribe_calendar",
      {
        url: z.string().describe("The URL of the iCalendar (.ics) feed"),
        name: z
          .string()
          .optional()
          .describe("A friendly name for the calendar"),
        refresh_interval: z
          .number()
          .optional()
          .default(60)
          .describe("Refresh interval in minutes"),
      },
      async ({ url, name, refresh_interval }) => {
        if (!this.userId) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Authentication required. Please authenticate first.",
              },
            ],
          };
        }

        const calendarId = crypto.randomUUID();
        const subscription: CalendarSubscription = {
          id: calendarId,
          url,
          name: name || `Calendar ${Date.now()}`,
          refreshInterval: refresh_interval,
          lastUpdated: new Date().toISOString(),
          userId: this.userId,
        };

        await this.kv.put(
          `user:${this.userId}:calendar:${calendarId}`,
          JSON.stringify(subscription),
        );

        const userCalendarsKey = `user:${this.userId}:calendars`;
        const existingList =
          (await this.kv.get<string[]>(userCalendarsKey, "json")) || [];
        existingList.push(calendarId);
        await this.kv.put(userCalendarsKey, JSON.stringify(existingList));

        return {
          content: [
            {
              type: "text",
              text: `Successfully subscribed to calendar: ${subscription.name} (ID: ${calendarId})`,
            },
          ],
        };
      },
    );

    // List calendars
    this.server.tool("list_calendars", {}, async () => {
      if (!this.userId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Authentication required. Please authenticate first.",
            },
          ],
        };
      }

      const userCalendarsKey = `user:${this.userId}:calendars`;
      const calendarIds =
        (await this.kv.get<string[]>(userCalendarsKey, "json")) || [];

      if (calendarIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No calendars subscribed. Use subscribe_calendar to add one.",
            },
          ],
        };
      }

      const calendars: CalendarSubscription[] = [];
      for (const id of calendarIds) {
        const calendar = await this.kv.get<CalendarSubscription>(
          `user:${this.userId}:calendar:${id}`,
          "json",
        );
        if (calendar) {
          calendars.push(calendar);
        }
      }

      const list = calendars
        .map((cal) => `- ${cal.name} (ID: ${cal.id})`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Your calendars:\n${list}`,
          },
        ],
      };
    });

    // Additional tools follow same pattern...
  }

  setUserId(userId: string) {
    this.userId = userId;
  }
}

// Legacy classes to maintain backward compatibility until migration
export class ICalMCP extends ICalMCPSQLite {}
export class ICalMCP_v2 extends ICalMCPSQLite {}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // OAuth Discovery Endpoints (handle various paths the client might try)
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration" ||
      url.pathname === "/.well-known/oauth-authorization-server/sse" ||
      url.pathname === "/.well-known/openid-configuration/sse" ||
      url.pathname === "/sse/.well-known/openid-configuration"
    ) {
      const metadata = {
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
        jwks_uri: `${url.origin}/.well-known/jwks.json`,
        response_types_supported: ["code", "token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "email"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        claims_supported: ["sub", "name", "email", "email_verified"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        service_documentation: `${url.origin}/docs`,
        ui_locales_supported: ["en"],
      };

      return new Response(JSON.stringify(metadata), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // OAuth Protected Resource metadata (handle various paths)
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/sse"
    ) {
      const metadata = {
        resource: url.origin,
        authorization_servers: [
          `${url.origin}/.well-known/oauth-authorization-server`,
        ],
        bearer_methods_supported: ["header"],
        resource_documentation: `${url.origin}/docs`,
        resource_signing_alg_values_supported: ["RS256"],
      };

      return new Response(JSON.stringify(metadata), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Handle dynamic client registration endpoint
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;

        // Generate a client ID and secret
        const clientId = `client_${crypto.randomUUID()}`;
        const clientSecret = `secret_${crypto.randomUUID()}`;

        // Store the client registration in KV (optional - for tracking)
        await env.CALENDAR_CACHE.put(
          `oauth_client:${clientId}`,
          JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: body.redirect_uris || [],
            grant_types: body.grant_types || ["authorization_code"],
            response_types: body.response_types || ["code"],
            client_name: body.client_name || "MCP Client",
            created_at: new Date().toISOString(),
          }),
          { expirationTtl: 90 * 24 * 60 * 60 }, // 90 days
        );

        // Return the client registration response
        const response = {
          client_id: clientId,
          client_secret: clientSecret,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0, // Never expires
          redirect_uris: body.redirect_uris || [],
          grant_types: body.grant_types || ["authorization_code"],
          response_types: body.response_types || ["code"],
          client_name: body.client_name || "MCP Client",
          token_endpoint_auth_method: "client_secret_basic",
          scope: "openid profile email",
        };

        return new Response(JSON.stringify(response), {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "invalid_client_metadata",
            error_description: "Invalid registration request",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
    }

    // Handle OAuth token endpoint
    if (url.pathname === "/token" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const grantType = formData.get("grant_type");
        const clientId = formData.get("client_id");
        const clientSecret = formData.get("client_secret");

        if (grantType === "authorization_code") {
          const code = formData.get("code");
          const redirectUri = formData.get("redirect_uri");
          const codeVerifier = formData.get("code_verifier");

          // Retrieve and validate the authorization code
          const storedCodeData = await env.CALENDAR_CACHE.get(
            `auth_code:${code}`,
          );
          if (!storedCodeData) {
            return new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Invalid or expired authorization code",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          const codeData = JSON.parse(storedCodeData);

          // Validate redirect URI matches
          if (codeData.redirect_uri !== redirectUri) {
            return new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Redirect URI mismatch",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          // Validate PKCE if present
          if (
            codeData.code_challenge &&
            codeVerifier &&
            typeof codeVerifier === "string"
          ) {
            // Verify PKCE challenge
            const encoder = new TextEncoder();
            const data = encoder.encode(codeVerifier);
            const hash = await crypto.subtle.digest("SHA-256", data);
            const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=/g, "");

            if (base64 !== codeData.code_challenge) {
              return new Response(
                JSON.stringify({
                  error: "invalid_grant",
                  error_description: "PKCE verification failed",
                }),
                {
                  status: 400,
                  headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                  },
                },
              );
            }
          }

          // Delete the used authorization code
          await env.CALENDAR_CACHE.delete(`auth_code:${code}`);

          // Generate an access token (simplified - just use MCP token format)
          const token = await new ClerkHandler({
            CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
            CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
          }).generateMCPToken("oauth_client");

          return new Response(
            JSON.stringify({
              access_token: `mcp_${token}`,
              token_type: "Bearer",
              expires_in: 86400, // 1 day
              scope: codeData.scope || "openid profile email",
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        if (grantType === "client_credentials") {
          // Validate client credentials if provided
          if (clientId) {
            const storedClient = await env.CALENDAR_CACHE.get(
              `oauth_client:${clientId}`,
            );
            if (storedClient) {
              const client = JSON.parse(storedClient);
              // Basic validation - in production you'd do more
              if (clientSecret && client.client_secret !== clientSecret) {
                return new Response(
                  JSON.stringify({
                    error: "invalid_client",
                    error_description: "Invalid client credentials",
                  }),
                  {
                    status: 401,
                    headers: {
                      "Content-Type": "application/json",
                      "Access-Control-Allow-Origin": "*",
                    },
                  },
                );
              }
            }
          }

          // Generate an access token (simplified - just use MCP token format)
          const token = await new ClerkHandler({
            CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
            CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
          }).generateMCPToken("oauth_client");

          return new Response(
            JSON.stringify({
              access_token: `mcp_${token}`,
              token_type: "Bearer",
              expires_in: 86400, // 1 day
              scope: "openid profile email",
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            error: "unsupported_grant_type",
            error_description: "Grant type not supported",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "server_error",
            error_description: "Failed to process token request",
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
    }

    // Handle OAuth authorization endpoint
    if (url.pathname === "/authorize" && request.method === "GET") {
      const responseType = url.searchParams.get("response_type");
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method");
      const scope = url.searchParams.get("scope");

      // For simplified OAuth flow, we'll auto-approve and redirect with a code
      // In production, you'd show a consent screen here
      if (responseType === "code" && clientId && redirectUri) {
        // Generate an authorization code
        const authCode = crypto.randomUUID();

        // Store the authorization code with PKCE challenge for later verification
        await env.CALENDAR_CACHE.put(
          `auth_code:${authCode}`,
          JSON.stringify({
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
            scope: scope || "openid profile email",
            created_at: Date.now(),
          }),
          { expirationTtl: 600 }, // 10 minutes
        );

        // Redirect back to the client with the authorization code
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set("code", authCode);
        if (state) {
          redirectUrl.searchParams.set("state", state);
        }

        return Response.redirect(redirectUrl.toString(), 302);
      }

      return new Response("Invalid authorization request", {
        status: 400,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Initialize Clerk handler
    const clerkHandler = new ClerkHandler({
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
      CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
    });

    // Handle SSE endpoint for MCP
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      const authHeader = request.headers.get("Authorization");

      // First check for OAuth/MCP tokens (don't try Clerk verification first)
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7); // Remove "Bearer "

        // Check if it's an MCP token
        if (token.startsWith("mcp_")) {
          const mcpToken = token.substring(4); // Remove "mcp_" prefix
          const mcpVerification = await clerkHandler.verifyMCPToken(mcpToken);

          if (mcpVerification.isValid && mcpVerification.userId) {
            // Valid MCP token, proceed
            console.log(
              "Authenticated with MCP token for user:",
              mcpVerification.userId,
            );
            // Pass userId as props to the MCP agent
            const props = { userId: mcpVerification.userId };
            ctx.props = props;
            return ICalMCPSQLite.serveSSE("/sse", {
              binding: "ICAL_MCP",
            }).fetch(request, env, ctx);
          }
        }

        // If not MCP token, try Clerk verification
        const verification = await clerkHandler.verifyRequest(request);
        if (verification.isValid) {
          // Authenticated via Clerk, proceed
          const props = { userId: verification.userId };
          ctx.props = props;
          return ICalMCPSQLite.serveSSE("/sse", { binding: "ICAL_MCP" }).fetch(
            request,
            env,
            ctx,
          );
        }
      }

      // No valid authentication found
      return new Response(
        JSON.stringify({
          error: "Authentication required",
          message:
            "Please visit the web interface to sign in and get your MCP token",
          url: url.origin,
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Generate MCP token (handle before general API routing)
    if (url.pathname === "/api/generate-token") {
      const verification = await clerkHandler.verifyRequest(request);

      if (!verification.isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const token = await clerkHandler.generateMCPToken(verification.userId!);

      return new Response(JSON.stringify({ token: `mcp_${token}` }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // API endpoints
    if (url.pathname.startsWith("/api/")) {
      const verification = await clerkHandler.verifyRequest(request);

      if (!verification.isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      return handleAPI(request, env, url, verification.userId!);
    }

    // Dashboard (client-side auth only)
    if (url.pathname === "/dashboard") {
      // Don't do server-side auth verification for dashboard
      // Let client-side Clerk handle authentication
      return new Response(
        getDashboardPage(url.origin, "", "", env.CLERK_PUBLISHABLE_KEY),
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    // Landing page (public)
    if (url.pathname === "/") {
      // Don't do server-side auth check to avoid redirect loops
      // Let client-side handle the redirect after Clerk loads
      return new Response(
        getLandingPage(url.origin, env.CLERK_PUBLISHABLE_KEY),
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Handle API requests
async function handleAPI(
  request: Request,
  env: Env,
  url: URL,
  userId: string,
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // List user's calendars
  if (url.pathname === "/api/calendars" && request.method === "GET") {
    const userCalendarsKey = `user:${userId}:calendars`;
    const calendarIds =
      (await env.CALENDAR_CACHE.get<string[]>(userCalendarsKey, "json")) || [];

    const calendars: CalendarSubscription[] = [];
    for (const id of calendarIds) {
      const calendar = await env.CALENDAR_CACHE.get<CalendarSubscription>(
        `user:${userId}:calendar:${id}`,
        "json",
      );
      if (calendar) {
        calendars.push(calendar);
      }
    }

    return new Response(JSON.stringify(calendars), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Add a calendar
  if (url.pathname === "/api/calendars" && request.method === "POST") {
    const body = (await request.json()) as {
      url: string;
      name?: string;
      refreshInterval?: number;
    };

    const calendarId = crypto.randomUUID();
    const subscription: CalendarSubscription = {
      id: calendarId,
      url: body.url,
      name: body.name || `Calendar ${Date.now()}`,
      refreshInterval: body.refreshInterval || 60,
      lastUpdated: new Date().toISOString(),
      userId,
    };

    await env.CALENDAR_CACHE.put(
      `user:${userId}:calendar:${calendarId}`,
      JSON.stringify(subscription),
    );

    const userCalendarsKey = `user:${userId}:calendars`;
    const existingList =
      (await env.CALENDAR_CACHE.get<string[]>(userCalendarsKey, "json")) || [];
    existingList.push(calendarId);
    await env.CALENDAR_CACHE.put(
      userCalendarsKey,
      JSON.stringify(existingList),
    );

    return new Response(JSON.stringify(subscription), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Delete a calendar
  if (
    url.pathname.match(/^\/api\/calendars\/[\w-]+$/) &&
    request.method === "DELETE"
  ) {
    const calendarId = url.pathname.split("/").pop()!;

    await env.CALENDAR_CACHE.delete(`user:${userId}:calendar:${calendarId}`);

    const userCalendarsKey = `user:${userId}:calendars`;
    const calendarIds =
      (await env.CALENDAR_CACHE.get<string[]>(userCalendarsKey, "json")) || [];
    const updated = calendarIds.filter((id) => id !== calendarId);
    await env.CALENDAR_CACHE.put(userCalendarsKey, JSON.stringify(updated));

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}

// Landing page HTML
function getLandingPage(origin: string, publishableKey: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>iCal MCP Server - Calendar Integration for AI Agents</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    .hero {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .hero-content {
      max-width: 1200px;
      text-align: center;
      color: white;
    }
    h1 {
      font-size: 3.5em;
      margin-bottom: 20px;
      font-weight: 700;
    }
    .subtitle {
      font-size: 1.5em;
      margin-bottom: 40px;
      opacity: 0.95;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 30px;
      margin: 60px 0;
    }
    .feature {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      padding: 30px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .feature h3 {
      font-size: 1.3em;
      margin-bottom: 15px;
    }
    .feature p {
      opacity: 0.9;
      line-height: 1.6;
    }
    .cta-buttons {
      margin-top: 40px;
    }
    .btn {
      display: inline-block;
      padding: 16px 32px;
      margin: 10px;
      border-radius: 12px;
      font-size: 1.1em;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s;
      cursor: pointer;
      border: none;
    }
    .btn-primary {
      background: white;
      color: #667eea;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.2);
      color: white;
      border: 2px solid white;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .tools {
      margin-top: 60px;
      padding-top: 40px;
      border-top: 1px solid rgba(255, 255, 255, 0.2);
    }
    .tools h2 {
      font-size: 2em;
      margin-bottom: 30px;
    }
    .tool-list {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 15px;
    }
    .tool-item {
      background: rgba(255, 255, 255, 0.1);
      padding: 10px 20px;
      border-radius: 25px;
      font-family: monospace;
      font-size: 0.95em;
    }
    .loading-spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255,255,255,.3);
      border-radius: 50%;
      border-top-color: #667eea;
      animation: spin 1s ease-in-out infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @media (max-width: 768px) {
      h1 { font-size: 2.5em; }
      .subtitle { font-size: 1.2em; }
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="hero-content">
      <h1>iCal MCP Server</h1>
      <p class="subtitle">Connect your calendars to AI agents with the Model Context Protocol</p>
      
      <div class="features">
        <div class="feature">
          <h3>Calendar Sync</h3>
          <p>Subscribe to any iCalendar feed and keep your events synchronized automatically</p>
        </div>
        <div class="feature">
          <h3>AI Integration</h3>
          <p>Works with Claude, Cursor, and any MCP-compatible AI assistant</p>
        </div>
        <div class="feature">
          <h3>Secure & Private</h3>
          <p>Your calendar data stays private with user-specific authentication</p>
        </div>
        <div class="feature">
          <h3>Real-time Access</h3>
          <p>AI agents can query your events, search, and help manage your schedule</p>
        </div>
      </div>

      <div class="cta-buttons">
        <button id="sign-in-btn" class="btn btn-primary">
          <span id="sign-in-text">Sign In to Get Started</span>
        </button>
        <button id="sign-up-btn" class="btn btn-secondary">
          <span id="sign-up-text">Create Account</span>
        </button>
      </div>

      <div class="tools">
        <h2>Available MCP Tools</h2>
        <div class="tool-list">
          <span class="tool-item">subscribe_calendar</span>
          <span class="tool-item">list_calendars</span>
          <span class="tool-item">unsubscribe_calendar</span>
          <span class="tool-item">get_events</span>
          <span class="tool-item">search_events</span>
          <span class="tool-item">get_upcoming_events</span>
          <span class="tool-item">get_daily_agenda</span>
        </div>
      </div>
    </div>
  </div>

  <script async crossorigin="anonymous" data-clerk-publishable-key="${publishableKey}" 
          src="https://right-mullet-53.clerk.accounts.dev/npm/@clerk/clerk-js@latest/dist/clerk.browser.js">
  </script>
  
  <script>
    // Wait for Clerk to be available
    function waitForClerk() {
      if (typeof window.Clerk !== 'undefined') {
        initializeClerk();
      } else {
        setTimeout(waitForClerk, 100);
      }
    }

    async function initializeClerk() {
      try {
        await window.Clerk.load();
        
        // Debug logging
        console.log('[Landing] Clerk loaded');
        console.log('[Landing] User:', window.Clerk.user ? 'Authenticated' : 'Not authenticated');
        console.log('[Landing] Session:', window.Clerk.session ? 'Active' : 'No session');
        
        // Handle OAuth callback redirect
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('__clerk_status') || urlParams.has('__clerk_created_session')) {
          console.log('[Landing] OAuth callback detected, waiting...');
          // Wait for Clerk to process the OAuth callback
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Check if user is already signed in
        if (window.Clerk.user) {
          console.log('[Landing] User authenticated, redirecting to dashboard');
          // Small delay to ensure session is fully established
          await new Promise(resolve => setTimeout(resolve, 500));
          window.location.href = '${origin}/dashboard';
          return;
        }
        
        // Sign in button
        document.getElementById('sign-in-btn').addEventListener('click', async () => {
          const btn = document.getElementById('sign-in-btn');
          const text = document.getElementById('sign-in-text');
          
          btn.disabled = true;
          text.innerHTML = '<span class="loading-spinner"></span> Opening...';
          
          try {
            await window.Clerk.openSignIn({
              fallbackRedirectUrl: '${origin}/dashboard',
              forceRedirectUrl: '${origin}/dashboard',
              signUpFallbackRedirectUrl: '${origin}/dashboard',
              signUpForceRedirectUrl: '${origin}/dashboard'
            });
          } catch (error) {
            console.error('Sign in error:', error);
            text.textContent = 'Sign In to Get Started';
            btn.disabled = false;
          }
        });
        
        // Sign up button
        document.getElementById('sign-up-btn').addEventListener('click', async () => {
          const btn = document.getElementById('sign-up-btn');
          const text = document.getElementById('sign-up-text');
          
          btn.disabled = true;
          text.innerHTML = '<span class="loading-spinner"></span> Opening...';
          
          try {
            await window.Clerk.openSignUp({
              fallbackRedirectUrl: '${origin}/dashboard',
              forceRedirectUrl: '${origin}/dashboard',
              signInFallbackRedirectUrl: '${origin}/dashboard',
              signInForceRedirectUrl: '${origin}/dashboard'
            });
          } catch (error) {
            console.error('Sign up error:', error);
            text.textContent = 'Create Account';
            btn.disabled = false;
          }
        });
        
      } catch (error) {
        console.error('Failed to initialize Clerk:', error);
        // Set up fallback buttons
        setupFallbackButtons();
      }
    }

    // Fallback to redirect if Clerk fails to load
    function setupFallbackButtons() {
      document.getElementById('sign-in-btn').addEventListener('click', () => {
        window.location.href = 'https://right-mullet-53.clerk.accounts.dev/sign-in?redirect_url=' + encodeURIComponent('${origin}/dashboard');
      });
      
      document.getElementById('sign-up-btn').addEventListener('click', () => {
        window.location.href = 'https://right-mullet-53.clerk.accounts.dev/sign-up?redirect_url=' + encodeURIComponent('${origin}/dashboard');
      });
    }

    // Start waiting for Clerk
    waitForClerk();
  </script>
</body>
</html>`;
}

// Dashboard HTML
function getDashboardPage(
  origin: string,
  userId: string,
  email?: string,
  publishableKey?: string,
): string {
  const clerkKey =
    publishableKey || "pk_test_cmlnaHQtbXVsbGV0LTUzLmNsZXJrLmFjY291bnRzLmRldiQ";
  return `<!DOCTYPE html>
<html>
<head>
  <title>Dashboard - iCal MCP Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      min-height: 100vh;
    }
    .header {
      background: white;
      border-bottom: 1px solid #e0e0e0;
      padding: 20px;
    }
    .header-content {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo {
      font-size: 1.5em;
      font-weight: 700;
      color: #667eea;
    }
    .user-info {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 40px auto;
      padding: 0 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }
    h2 {
      color: #333;
      margin-bottom: 20px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #555;
      font-weight: 500;
    }
    input, textarea {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
    }
    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover {
      opacity: 0.9;
    }
    .calendar-item {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .config-box {
      background: #f0f4ff;
      border: 2px solid #667eea;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
    }
    .config-box h3 {
      color: #667eea;
      margin-bottom: 15px;
    }
    pre {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 15px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      word-break: break-all;
    }
    .token-display {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 15px;
      border-radius: 8px;
      margin: 20px 0;
      word-break: break-all;
      font-family: monospace;
      font-size: 14px;
      overflow-wrap: break-word;
    }
    .copy-btn {
      background: #28a745;
      padding: 8px 16px;
      font-size: 14px;
      margin-left: 10px;
    }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      border-bottom: 2px solid #e0e0e0;
    }
    .tab {
      padding: 10px 20px;
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
    }
    .tab.active {
      color: #667eea;
      border-bottom-color: #667eea;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="logo">iCal MCP Server</div>
      <div class="user-info">
        <span>${email || userId}</span>
        <button onclick="signOut()">Sign Out</button>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="grid">
      <div class="card">
        <h2>Your Calendars</h2>
        <div id="calendar-list"></div>
        
        <h2 style="margin-top: 30px;">Add Calendar</h2>
        <form id="add-calendar-form">
          <div class="form-group">
            <label>Calendar URL (.ics)</label>
            <input type="url" id="calendar-url" required placeholder="https://calendar.example.com/feed.ics">
          </div>
          <div class="form-group">
            <label>Calendar Name</label>
            <input type="text" id="calendar-name" placeholder="My Calendar">
          </div>
          <div class="form-group">
            <label>Refresh Interval (minutes)</label>
            <input type="number" id="refresh-interval" value="60" min="5">
          </div>
          <button type="submit">Add Calendar</button>
        </form>
      </div>

      <div class="card">
        <h2>MCP Configuration</h2>
        
        <div class="config-box">
          <h3>Your MCP Token</h3>
          <p style="margin-bottom: 15px;">Use this token to authenticate MCP clients:</p>
          <div class="token-display" id="mcp-token">
            Loading...
          </div>
          <button onclick="copyToken()" class="copy-btn">Copy Token</button>
          <button onclick="regenerateToken()">Regenerate Token</button>
        </div>

        <div class="tabs" style="margin-top: 30px;">
          <button class="tab active" onclick="showTab('claude')">Claude Desktop</button>
          <button class="tab" onclick="showTab('cursor')">Cursor</button>
          <button class="tab" onclick="showTab('other')">Other Clients</button>
        </div>

        <div id="claude" class="tab-content active">
          <h3>Claude Desktop Configuration</h3>
          <p>Add this to your claude_desktop_config.json:</p>
          <pre>{
  "mcpServers": {
    "ical": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "--header",
        "Authorization: Bearer <span id="token-claude">YOUR_TOKEN</span>",
        "${origin}/sse"
      ]
    }
  }
}</pre>
        </div>

        <div id="cursor" class="tab-content">
          <h3>Cursor Configuration</h3>
          <p>Add this to your Cursor MCP settings:</p>
          <pre>{
  "ical": {
    "command": "npx",
    "args": [
      "mcp-remote",
      "--header",
      "Authorization: Bearer <span id="token-cursor">YOUR_TOKEN</span>",
      "${origin}/sse"
    ]
  }
}</pre>
        </div>

        <div id="other" class="tab-content">
          <h3>Other MCP Clients</h3>
          <p>Connect to the following endpoint with your token:</p>
          <pre>Endpoint: ${origin}/sse
Header: Authorization: Bearer <span id="token-other">YOUR_TOKEN</span></pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentToken = null;
    let clerkToken = null;

    // Get Clerk session token
    async function getClerkToken() {
      if (window.Clerk && window.Clerk.session) {
        try {
          // Get the default Clerk JWT token
          const token = await window.Clerk.session.getToken();
          console.log('[Dashboard] Got Clerk token:', token ? 'Token obtained' : 'No token');
          return token;
        } catch (error) {
          console.error('[Dashboard] Error getting Clerk token:', error);
          return null;
        }
      }
      return null;
    }

    // Load calendars
    async function loadCalendars() {
      const token = await getClerkToken();
      if (!token) {
        console.error('No auth token available');
        document.getElementById('calendar-list').innerHTML = '<p style="color: #999;">Please sign in</p>';
        return;
      }

      const response = await fetch('/api/calendars', {
        headers: {
          'Authorization': 'Bearer ' + token
        }
      });
      if (!response.ok) {
        console.error('Failed to load calendars:', response.status);
        document.getElementById('calendar-list').innerHTML = '<p style="color: #999;">Failed to load calendars</p>';
        return;
      }
      const calendars = await response.json();
      
      const listDiv = document.getElementById('calendar-list');
      if (calendars.length === 0) {
        listDiv.innerHTML = '<p style="color: #999;">No calendars added yet</p>';
      } else {
        listDiv.innerHTML = calendars.map(cal => {
          // Truncate URL for display - show first 50 chars and last 20 chars
          const displayUrl = cal.url.length > 80 
            ? cal.url.substring(0, 50) + '...' + cal.url.substring(cal.url.length - 20)
            : cal.url;
          
          return \`
          <div class="calendar-item">
            <div style="overflow: hidden;">
              <strong>\${cal.name}</strong><br>
              <small style="color: #666;" title="\${cal.url}">\${displayUrl}</small>
            </div>
            <button onclick="deleteCalendar('\${cal.id}')" style="background: #dc3545;">Delete</button>
          </div>
        \`}).join('');
      }
    }

    // Load MCP token
    async function loadToken() {
      const token = await getClerkToken();
      if (!token) {
        console.error('No auth token available');
        document.getElementById('mcp-token').textContent = 'Please sign in';
        return;
      }

      const response = await fetch('/api/generate-token', {
        headers: {
          'Authorization': 'Bearer ' + token
        }
      });
      if (!response.ok) {
        console.error('Failed to generate token:', response.status);
        document.getElementById('mcp-token').textContent = 'Failed to generate token';
        return;
      }
      const data = await response.json();
      currentToken = data.token;
      
      // Display truncated token (show first 20 and last 10 chars)
      const truncatedToken = currentToken.length > 40 
        ? currentToken.substring(0, 20) + '...' + currentToken.substring(currentToken.length - 10)
        : currentToken;
      
      document.getElementById('mcp-token').textContent = truncatedToken;
      // Keep full token in data attribute for copying
      document.getElementById('mcp-token').setAttribute('data-full-token', currentToken);
      
      // Update config examples with full token
      document.getElementById('token-claude').textContent = currentToken;
      document.getElementById('token-cursor').textContent = currentToken;
      document.getElementById('token-other').textContent = currentToken;
    }

    // Add calendar
    document.getElementById('add-calendar-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const token = await getClerkToken();
      if (!token) {
        alert('Please sign in to add calendars');
        return;
      }

      const formData = {
        url: document.getElementById('calendar-url').value,
        name: document.getElementById('calendar-name').value || undefined,
        refreshInterval: parseInt(document.getElementById('refresh-interval').value)
      };

      const response = await fetch('/api/calendars', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        document.getElementById('add-calendar-form').reset();
        loadCalendars();
      }
    });

    // Delete calendar
    async function deleteCalendar(calendarId) {
      if (confirm('Delete this calendar?')) {
        const token = await getClerkToken();
        if (!token) {
          alert('Please sign in to delete calendars');
          return;
        }

        const response = await fetch(\`/api/calendars/\${calendarId}\`, {
          method: 'DELETE',
          headers: {
            'Authorization': 'Bearer ' + token
          }
        });

        if (response.ok) {
          loadCalendars();
        }
      }
    }

    // Copy token
    function copyToken() {
      navigator.clipboard.writeText(currentToken);
      alert('Token copied to clipboard!');
    }

    // Regenerate token
    async function regenerateToken() {
      if (confirm('Regenerate token? Your current token will stop working.')) {
        await loadToken();
        alert('New token generated!');
      }
    }

    // Tab switching
    function showTab(tabName) {
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      
      event.target.classList.add('active');
      document.getElementById(tabName).classList.add('active');
    }

    // Sign out
    async function signOut() {
      try {
        if (window.Clerk) {
          await window.Clerk.signOut();
        }
      } catch (error) {
        console.error('Sign out error:', error);
      }
      // Always redirect to landing page
      window.location.href = '/';
    }

    // Initialize Clerk and load data
    async function initialize() {
      try {
        // Wait for Clerk to be fully loaded
        let retries = 0;
        while (!window.Clerk && retries < 30) {
          await new Promise(resolve => setTimeout(resolve, 100));
          retries++;
        }
        
        console.log('[Dashboard] Clerk loading attempts:', retries);
        
        if (!window.Clerk) {
          console.error('[Dashboard] Clerk failed to load after 3 seconds');
          window.location.href = '/';
          return;
        }

        await window.Clerk.load();
        
        console.log('[Dashboard] Clerk loaded');
        console.log('[Dashboard] User:', window.Clerk.user ? 'Authenticated' : 'Not authenticated');
        console.log('[Dashboard] Session:', window.Clerk.session ? 'Active' : 'No session');
        
        // Wait a bit for session to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check if user is authenticated
        if (!window.Clerk.user) {
          console.log('[Dashboard] No authenticated user, redirecting to home');
          window.location.href = '/';
          return;
        }
        
        console.log('[Dashboard] User authenticated:', window.Clerk.user.id);
        console.log('[Dashboard] User email:', window.Clerk.user.primaryEmailAddress?.emailAddress);
        
        // Load dashboard data
        loadCalendars();
        loadToken();
      } catch (error) {
        console.error('[Dashboard] Initialization error:', error);
        // Redirect to home on error
        window.location.href = '/';
      }
    }
    
    // Start initialization when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
    } else {
      initialize();
    }
  </script>
  
  <script async crossorigin="anonymous" data-clerk-publishable-key="${clerkKey}" 
          src="https://right-mullet-53.clerk.accounts.dev/npm/@clerk/clerk-js@latest/dist/clerk.browser.js">
  </script>
</body>
</html>`;
}

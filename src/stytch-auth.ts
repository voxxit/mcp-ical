import * as stytch from "stytch";

// Stytch configuration
export class StytchAuth {
  private static client: stytch.Client | null = null;
  private static projectId: string;
  private static publicToken: string;

  static initialize(
    projectId: string,
    secretKey: string,
    publicToken: string,
    env: "test" | "live" = "test",
  ) {
    this.projectId = projectId;
    this.publicToken = publicToken;

    console.log("Initializing Stytch client:", {
      projectId,
      env,
      hasSecret: !!secretKey,
      hasPublicToken: !!publicToken,
    });

    this.client = new stytch.Client({
      project_id: projectId,
      secret: secretKey,
      env: env === "test" ? stytch.envs.test : stytch.envs.live,
    });
  }

  static getClient(): stytch.Client {
    if (!this.client) {
      throw new Error(
        "Stytch client not initialized. Call StytchAuth.initialize() first.",
      );
    }
    return this.client;
  }

  static getProjectId(): string {
    return this.projectId;
  }

  static getPublicToken(): string {
    return this.publicToken;
  }

  // Verify session token
  static async verifySession(sessionToken: string): Promise<any> {
    const client = this.getClient();
    return await client.sessions.authenticate({
      session_token: sessionToken,
    });
  }

  // Verify JWT token
  static async verifyJWT(token: string): Promise<any> {
    const client = this.getClient();
    return await client.sessions.authenticateJwt({
      session_jwt: token,
    });
  }

  // Send magic link with proper configuration
  static async sendMagicLink(
    email: string,
    redirectUrl: string,
    expirationMinutes: number = 30,
  ): Promise<any> {
    const client = this.getClient();
    return await client.magicLinks.email.loginOrCreate({
      email,
      login_magic_link_url: redirectUrl,
      signup_magic_link_url: redirectUrl,
      login_expiration_minutes: expirationMinutes,
      signup_expiration_minutes: expirationMinutes,
    });
  }

  // Get Stytch OAuth endpoint URL
  static getOAuthEndpointUrl(env: "test" | "live", endpoint: string): string {
    // Use custom domain for test environment to avoid CNAME errors
    const stytchBaseUrl =
      env === "test" ? "https://login-test.srv.im" : "https://api.stytch.com";
    return `${stytchBaseUrl}/v1/public/connected_apps/${endpoint}`;
  }

  // Get OAuth authorization server metadata pointing to Stytch's endpoints
  static getAuthorizationServerMetadata(baseUrl: string) {
    // For OAuth endpoints, use the same domain as the MCP server since it's configured in Stytch
    // This avoids CNAME record issues when Stytch expects requests from configured domains

    return {
      issuer: baseUrl, // OAuth 2.1 requires issuer to be a URL, not just project ID
      authorization_endpoint: `${baseUrl}/oauth/authorize`, // Our redirect handler
      token_endpoint: `${baseUrl}/oauth2/token`, // Proxy to Stytch
      registration_endpoint: `${baseUrl}/oauth2/register`, // Proxy to Stytch
      jwks_uri: `${baseUrl}/.well-known/jwks.json`, // Proxy to Stytch
      scopes_supported: [
        "read:calendars",
        "manage:calendars",
        "read:events",
        "calendars:*",
        "openid",
        "profile",
        "email",
      ],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      registration_endpoint_auth_methods_supported: ["none"],
    };
  }
}

// User context interface for MCP sessions
export interface UserContext {
  userId: string;
  email: string;
  name?: string;
  sessionId: string;
  scopes: string[];
  attributes?: Record<string, any>;
}

// Extract user context from Stytch session or JWT response
export function extractUserContext(sessionResponse: any): UserContext {
  const { session, user } = sessionResponse;

  // Default scopes for calendar access
  const defaultScopes = [
    "read:calendars",
    "manage:calendars", 
    "read:events",
    "calendars:*",
  ];

  // Handle JWT authentication responses (which may not have full user object)
  if (!user && session) {
    // For JWT responses, user data is typically in the session claims
    return {
      userId: session.user_id || session.subject || session.sub,
      email: session.custom_claims?.email || session.email || "",
      name: session.custom_claims?.name || session.name || undefined,
      sessionId: session.session_id,
      scopes: session.scopes || session.custom_claims?.scopes || defaultScopes,
      attributes: session.custom_claims || {},
    };
  }

  // Handle full session authentication responses
  return {
    userId: user.user_id,
    email: user.emails[0]?.email || "",
    name:
      user.name?.first_name && user.name?.last_name
        ? `${user.name.first_name} ${user.name.last_name}`
        : user.name?.first_name || undefined,
    sessionId: session.session_id,
    scopes: session.scopes || defaultScopes,
    attributes: user.attributes || {},
  };
}

// Tool to scope mappings
export const TOOL_SCOPE_MAPPINGS: Record<string, string[]> = {
  list_calendars: ["read:calendars", "manage:calendars", "calendars:*"],
  subscribe_calendar: ["manage:calendars", "calendars:*"],
  unsubscribe_calendar: ["manage:calendars", "calendars:*"],
  get_events: ["read:events", "calendars:*"],
  search_events: ["read:events", "calendars:*"],
  get_upcoming_events: ["read:events", "calendars:*"],
  get_daily_agenda: ["read:events", "calendars:*"],
};

// Check if user has any of the required scopes for a tool
export function hasRequiredScope(
  userScopes: string[],
  toolName: string,
): boolean {
  const requiredScopes = TOOL_SCOPE_MAPPINGS[toolName];
  if (!requiredScopes || requiredScopes.length === 0) {
    return true; // No scope required
  }

  return requiredScopes.some((scope) => userScopes.includes(scope));
}

// Validate scope authorization for a specific tool
export function validateToolAccess(
  userContext: UserContext | null,
  toolName: string,
): { authorized: boolean; error?: string } {
  if (!userContext) {
    return {
      authorized: false,
      error: "Authentication required",
    };
  }

  if (!hasRequiredScope(userContext.scopes, toolName)) {
    const requiredScopes = TOOL_SCOPE_MAPPINGS[toolName];
    return {
      authorized: false,
      error: `Insufficient permissions. Required scopes: ${requiredScopes.join(" OR ")}`,
    };
  }

  return { authorized: true };
}

// Middleware function to extract and verify authentication
export async function authenticateRequest(
  request: Request,
): Promise<UserContext | null> {
  try {
    // Try Authorization header first (Bearer token)
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const jwtResponse = await StytchAuth.verifyJWT(token);
      return extractUserContext(jwtResponse);
    }

    // Try session cookie
    const sessionCookie = request.headers
      .get("Cookie")
      ?.split(";")
      .find((c) => c.trim().startsWith("stytch_session="))
      ?.split("=")[1];

    if (sessionCookie) {
      const sessionResponse = await StytchAuth.verifySession(sessionCookie);
      return extractUserContext(sessionResponse);
    }

    return null;
  } catch (error) {
    console.error("Authentication failed:", error);
    return null;
  }
}

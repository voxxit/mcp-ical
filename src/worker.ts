import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import {
  StytchAuth,
  UserContext,
  extractUserContext,
} from "./stytch-auth";
import { CalendarMCP } from "./calendar-mcp";
import { stytchBearerTokenAuthMiddleware } from "./lib/auth";

// Environment interface for Cloudflare Worker
interface Env {
  AUTH_STORE: KVNamespace;
  CALENDARS: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  STYTCH_PROJECT_ID: string;
  STYTCH_SECRET_KEY: string;
  STYTCH_PUBLIC_TOKEN: string;
  STYTCH_PROJECT_ENV: string;
  STYTCH_DOMAIN: string;
  FRONTEND_URL: string;
  ASSETS: Fetcher;
}

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// API routes for the frontend
const apiRoutes = new Hono<{ Bindings: Env }>();

// Initialize Stytch middleware - ensures Stytch is initialized for all requests
app.use("/*", async (c, next) => {
  // Initialize Stytch if not already initialized
  try {
    StytchAuth.getClient();
  } catch {
    // Client not initialized, initialize it now
    StytchAuth.initialize(
      c.env.STYTCH_PROJECT_ID,
      c.env.STYTCH_SECRET_KEY,
      c.env.STYTCH_PUBLIC_TOKEN,
      c.env.STYTCH_PROJECT_ENV as "test" | "live",
    );
  }
  await next();
});

// Add CORS middleware
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

// OAuth 2.0 Discovery endpoints (no auth required)
app.get("/.well-known/oauth-protected-resource", async (c) => {
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  // RFC 9728 - Protected Resource Metadata
  const metadata = {
    resource: baseUrl,
    authorization_servers: [baseUrl], // This server acts as both resource and authorization server
    scopes_supported: [
      "read:calendars",
      "manage:calendars",
      "read:events",
      "calendars:*",
      "openid",
      "profile",
      "email",
    ],
    bearer_methods_supported: ["header"],
    resource_documentation: `${baseUrl}/docs`,
    resource_policy_uri: `${baseUrl}/privacy`,
  };

  return c.json(metadata);
});

app.get("/.well-known/oauth-authorization-server", async (c) => {
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const stytchApiDomain =
    c.env.STYTCH_PROJECT_ENV === "live"
      ? "https://api.stytch.com"
      : "https://login-test.srv.im";

  // RFC 8414 - Authorization Server Metadata (OAuth 2.1 compliant)
  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth2/token`,
    userinfo_endpoint: `${stytchApiDomain}/v1/sessions/authenticate`,
    jwks_uri: `${stytchApiDomain}/v1/public/${c.env.STYTCH_PROJECT_ID}/jwks`,
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
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["none"], // Public client
    code_challenge_methods_supported: ["S256"], // OAuth 2.1 requires PKCE
    pkce_code_challenge_methods_supported: ["S256"], // Explicit PKCE support
    require_pushed_authorization_requests: false,
    pushed_authorization_request_endpoint: null,
    require_signed_request_object: false,
    request_object_signing_alg_values_supported: [],
    authorization_response_iss_parameter_supported: true,
    // RFC 7591 - Dynamic Client Registration - Use Stytch's DCR endpoint
    registration_endpoint: `${stytchApiDomain}/v1/public/${c.env.STYTCH_PROJECT_ID}/oauth2/register`,
    registration_endpoint_auth_methods_supported: ["none"] // Public registration
  };

  return c.json(metadata);
});

// Generate PKCE code verifier and challenge
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// OAuth authorization endpoint - handles dynamic client registration
app.get("/oauth/authorize", async (c) => {
  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const scope = c.req.query("scope");
  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");
  const codeChallengeMethod = c.req.query("code_challenge_method");
  const provider = c.req.query("provider") || "google"; // Default to google

  console.log("OAuth authorize request:", {
    clientId,
    redirectUri,
    state,
    provider,
    codeChallenge: codeChallenge?.substring(0, 10) + "...",
    codeChallengeMethod,
  });

  // Validate provider
  const supportedProviders = ["github", "google"];
  if (!supportedProviders.includes(provider)) {
    return c.json(
      {
        error: "invalid_request",
        error_description: `Unsupported provider: ${provider}. Supported providers are: ${supportedProviders.join(", ")}`,
      },
      400,
    );
  }

  // OAuth 2.1 requires PKCE for all clients
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "PKCE with S256 code challenge method is required",
      },
      400,
    );
  }

  // OAuth 2.1 requires state parameter
  if (!state) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "State parameter is required",
      },
      400,
    );
  }

  if (!clientId || !redirectUri) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Missing client_id or redirect_uri",
      },
      400,
    );
  }

  // Store the original request parameters in KV for the callback
  const requestId = `oauth_req_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const oauthRequestData = {
    clientId,
    redirectUri, // This is the client's callback URL (e.g., http://127.0.0.1:4208/oauth/callback)
    scope: scope || "read:calendars manage:calendars read:events",
    state, // The client's state parameter
    provider, // Store the provider choice
    codeChallenge,
    codeChallengeMethod,
    createdAt: Date.now(),
  };
  
  console.log("Storing OAuth request:", {
    requestId,
    key: `oauth_request:${requestId}`,
    redirectUri: oauthRequestData.redirectUri,
    state: oauthRequestData.state,
  });
  
  await c.env.AUTH_STORE.put(
    `oauth_request:${requestId}`,
    JSON.stringify(oauthRequestData),
    { expirationTtl: 600 },
  ); // 10 minutes

  // Use the correct Stytch OAuth domain (not API domain)
  const stytchOAuthDomain =
    c.env.STYTCH_PROJECT_ENV === "live"
      ? "https://login.stytch.com"
      : "https://login-test.srv.im";

  // Our callback URL where Stytch will redirect after authentication
  const ourCallbackUrl = `${new URL(c.req.url).origin}/oauth/complete`;

  // For OAuth flows, use the /v1/public/oauth/{provider}/start endpoint
  const stytchUrl =
    `${stytchOAuthDomain}/v1/public/oauth/${provider}/start?` +
    new URLSearchParams({
      public_token: c.env.STYTCH_PUBLIC_TOKEN,
      login_redirect_url: ourCallbackUrl,
      signup_redirect_url: ourCallbackUrl,
      state: requestId, // Pass requestId as state - Stytch should return this
    }).toString();

  console.log("Redirecting to Stytch OAuth:", {
    stytchUrl: stytchUrl.replace(c.env.STYTCH_PUBLIC_TOKEN, '[REDACTED]'),
    requestId,
    ourCallbackUrl,
    clientCallbackUrl: redirectUri,
  });

  // Set a cookie with the request ID so we can retrieve it after Stytch redirect
  // This is a workaround for Stytch not preserving the state parameter
  setCookie(c, 'oauth_request_id', requestId, {
    httpOnly: true,
    secure: c.req.url.startsWith('https'),
    sameSite: 'Lax',
    maxAge: 600, // 10 minutes
    path: '/'
  });

  return c.redirect(stytchUrl);
});

// OAuth complete endpoint - handles Stytch OAuth completion
app.get("/oauth/complete", async (c) => {
  const params = new URL(c.req.url).searchParams;
  // Stytch returns the token as "token" not "stytch_token"
  const stytchToken = params.get("token") || params.get("stytch_token");
  const stytchTokenType = params.get("stytch_token_type");
  const stateParam = params.get("state");
  const error = params.get("error");

  console.log("OAuth complete request:", {
    hasToken: !!stytchToken,
    tokenType: stytchTokenType,
    state: stateParam,
    stateLength: stateParam?.length,
    error,
    allParams: Object.fromEntries(params.entries()),
    url: c.req.url,
  });

  // Try to get auth request ID from multiple sources:
  // 1. State parameter (if Stytch preserved it)
  // 2. Cookie (our workaround)
  // 3. Direct parameter
  const cookieRequestId = getCookie(c, 'oauth_request_id');
  let authRequestId = stateParam || cookieRequestId || params.get("auth_request_id");
  
  console.log("Looking for auth request ID:", {
    fromState: stateParam,
    fromCookie: cookieRequestId,
    fromParam: params.get("auth_request_id"),
    selected: authRequestId,
  });
  
  // Clear the cookie after reading it
  if (cookieRequestId) {
    setCookie(c, 'oauth_request_id', '', {
      httpOnly: true,
      secure: c.req.url.startsWith('https'),
      sameSite: 'Lax',
      maxAge: 0, // Delete cookie
      path: '/'
    });
  }

  // Retrieve stored OAuth parameters from KV
  let oauthRequest = null;
  if (authRequestId) {
    const storageKey = `oauth_request:${authRequestId}`;
    console.log("Attempting to retrieve OAuth request:", {
      authRequestId,
      storageKey,
    });
    
    const storedData = await c.env.AUTH_STORE.get(storageKey);
    if (storedData) {
      try {
        oauthRequest = JSON.parse(storedData);
        // Don't delete yet - we might need it if authentication fails
        console.log("Found stored OAuth request:", {
          clientId: oauthRequest.clientId,
          hasRedirectUri: !!oauthRequest.redirectUri,
          hasState: !!oauthRequest.state,
          storedDataLength: storedData.length,
        });
      } catch (e) {
        console.error("Failed to parse stored auth request:", e, "Data:", storedData);
      }
    } else {
      console.warn(`No stored auth request found for ID: ${authRequestId}, key: ${storageKey}`);
    }
  } else if (stateParam) {
    // Only warn if we expected a state parameter
    console.warn("No auth_request_id found in parameters or state");
  }

  if (error) {
    // If we have OAuth request data, redirect back to client with error
    if (oauthRequest) {
      const errorParams = new URLSearchParams({
        error: "access_denied",
        error_description: "User authentication failed",
      });
      if (oauthRequest.state) errorParams.set("state", oauthRequest.state);
      return c.redirect(
        `${oauthRequest.redirectUri}?${errorParams.toString()}`,
        302,
      );
    }

    return c.html(
      `<!DOCTYPE html>
      <html>
      <head><title>Authentication Error</title></head>
      <body>
        <h2>Authentication Failed</h2>
        <p>Error: ${error}</p>
      </body>
      </html>`,
      400,
    );
  }

  if (!stytchToken) {
    // If we have OAuth request data, redirect back to client with error
    if (oauthRequest) {
      const errorParams = new URLSearchParams({
        error: "access_denied",
        error_description: "No authentication token received",
      });
      if (oauthRequest.state) errorParams.set("state", oauthRequest.state);
      return c.redirect(
        `${oauthRequest.redirectUri}?${errorParams.toString()}`,
        302,
      );
    }

    return c.html(
      `<!DOCTYPE html>
      <html>
      <head><title>Authentication Error</title></head>
      <body>
        <h2>No Authentication Token</h2>
        <p>Missing authentication token from Stytch</p>
      </body>
      </html>`,
      400,
    );
  }

  try {
    // Authenticate with Stytch OAuth token (client already initialized by middleware)
    const response = await StytchAuth.getClient().oauth.authenticate({
      token: stytchToken,
      session_duration_minutes: 1440, // 24 hours
    });
    
    const userContext = extractUserContext(response);
    const sessionJWT = response.session_jwt;

    // Success - generate authorization code and redirect back to MCP client
    if (oauthRequest) {
      // Generate authorization code
      const authCode = `auth_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const authCodeKey = `auth_code:${authCode}`;

      console.log("Generating authorization code:", {
        authCode,
        authCodeKey,
        clientId: oauthRequest.clientId,
        hasCodeChallenge: !!oauthRequest.codeChallenge,
        codeChallengeMethod: oauthRequest.codeChallengeMethod,
      });

      // Store the authorization code mapping with PKCE challenge
      const authCodeData = {
        userContext: {
          userId: userContext.userId,
          email: userContext.email,
          name: userContext.name || "",
          sessionId: userContext.sessionId,
          scopes: userContext.scopes || ["read:calendars", "manage:calendars", "read:events", "calendars:*"],
        },
        sessionJWT,
        type: "oauth",
        clientId: oauthRequest.clientId,
        codeChallenge: oauthRequest.codeChallenge,
        codeChallengeMethod: oauthRequest.codeChallengeMethod,
        scope: oauthRequest.scope || "read:calendars manage:calendars read:events calendars:*",
        createdAt: Date.now(),
      };
      
      console.log("Storing authorization code data:", {
        key: authCodeKey,
        dataSize: JSON.stringify(authCodeData).length,
        expirationTtl: 600,
      });
      
      await c.env.AUTH_STORE.put(
        authCodeKey,
        JSON.stringify(authCodeData),
        { expirationTtl: 600 },
      ); // 10 minutes

      // Verify it was stored
      const verifyStored = await c.env.AUTH_STORE.get(authCodeKey);
      console.log("Verification after storage:", {
        key: authCodeKey,
        wasStored: !!verifyStored,
        storedDataSize: verifyStored ? verifyStored.length : 0,
      });

      // Clean up the stored auth request now that we've successfully processed it
      await c.env.AUTH_STORE.delete(`auth_request:${authRequestId}`);

      // Redirect back to the client's callback URL with authorization code
      const successParams = new URLSearchParams({
        code: authCode,
      });
      if (oauthRequest.state) {
        successParams.set("state", oauthRequest.state);
      }

      console.log("Redirecting to client callback:", {
        redirectUri: oauthRequest.redirectUri,
        code: authCode.substring(0, 10) + "...",
        state: oauthRequest.state,
      });

      return c.redirect(
        `${oauthRequest.redirectUri}?${successParams.toString()}`,
        302,
      );
    } else {
      // No OAuth request data found - this is a direct authentication from the UI
      // Store session data for later use
      const sessionData = {
        userId: userContext.userId,
        email: userContext.email,
        name: userContext.name || "",
        sessionJWT,
        createdAt: Date.now(),
      };

      // Store session in KV for future reference
      await c.env.AUTH_STORE.put(
        `session:${userContext.userId}`,
        JSON.stringify(sessionData),
        { expirationTtl: 86400 }, // 24 hours
      );

      // For direct UI authentication, redirect to the app root or show success
      // Check if this was from the UI (no redirect params)
      if (typeof window !== 'undefined' || c.req.header('accept')?.includes('text/html')) {
        // Return HTML that will redirect to the app root
        return c.html(
          `<!DOCTYPE html>
          <html>
          <head>
            <title>Authorization Complete</title>
            <script>
              // Redirect to app root after a short delay
              setTimeout(() => {
                window.location.href = '/';
              }, 1500);
            </script>
          </head>
          <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <div style="background: #e8f5e8; padding: 20px; border-radius: 8px; max-width: 500px; margin: 0 auto;">
              <h2 style="color: #2e7d32;">✓ Authentication Successful!</h2>
              <p>Authentication completed successfully.</p>
              <div style="background: white; padding: 15px; border-radius: 4px; margin: 20px 0; text-align: left;">
                <strong>Authenticated as:</strong> ${userContext.email}<br>
                ${userContext.name ? `<strong>Name:</strong> ${userContext.name}<br>` : ""}
                <strong>User ID:</strong> ${userContext.userId}
              </div>
              <p>Redirecting to the application...</p>
            </div>
          </body>
          </html>`,
          200,
        );
      } else {
        // For API calls, return JSON
        return c.json({
          success: true,
          user: {
            userId: userContext.userId,
            email: userContext.email,
            name: userContext.name,
          },
        });
      }
    }
  } catch (error) {
    console.error("OAuth token verification failed:", error);
    
    // If we have OAuth request data, redirect back to client with error
    if (oauthRequest) {
      const errorParams = new URLSearchParams({
        error: "server_error",
        error_description: "Failed to verify authentication token",
      });
      if (oauthRequest.state) errorParams.set("state", oauthRequest.state);
      return c.redirect(
        `${oauthRequest.redirectUri}?${errorParams.toString()}`,
        302,
      );
    }
    
    const errorPage = `<!DOCTYPE html>
      <html>
      <head><title>Authentication Failed</title></head>
      <body>
        <div style="text-align: center; padding: 40px;">
          <h2>Authentication Failed</h2>
          <p>Unable to verify your authentication token</p>
          <p>Error: ${error instanceof Error ? error.message : "Unknown error"}</p>
          <p>Close this tab and try again.</p>
        </div>
      </body>
      </html>`;

    return c.html(errorPage, 400);
  }
});

// Token exchange endpoint
app.post("/oauth2/token", async (c) => {
  const formData = await c.req.formData();
  const grantType = formData.get("grant_type");
  const authCode = formData.get("code");
  const codeVerifier = formData.get("code_verifier");

  console.log("Token exchange request:", {
    grantType,
    authCode: authCode ? authCode.toString().substring(0, 20) + "..." : null,
    hasCodeVerifier: !!codeVerifier,
    codeVerifierLength: codeVerifier ? codeVerifier.toString().length : 0,
  });

  if (grantType !== "authorization_code" || !authCode) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Invalid grant_type or missing code",
      },
      400,
    );
  }

  // OAuth 2.1 requires PKCE code verifier
  if (!codeVerifier || typeof codeVerifier !== "string") {
    return c.json(
      {
        error: "invalid_request",
        error_description:
          "PKCE code verifier is required and must be a string",
      },
      400,
    );
  }

  try {
    // Get the authorization code data
    const authCodeKey = `auth_code:${authCode}`;
    console.log("Looking up authorization code:", { key: authCodeKey });
    
    const codeData = await c.env.AUTH_STORE.get(authCodeKey);
    if (!codeData) {
      console.error("Authorization code not found:", {
        code: authCode,
        key: authCodeKey,
      });
      
      // List recent auth codes for debugging
      const recentKeys = await c.env.AUTH_STORE.list({ prefix: "auth_code:" });
      console.log("Recent auth codes in storage:", {
        count: recentKeys.keys.length,
        keys: recentKeys.keys.map(k => k.name),
      });
      
      return c.json(
        {
          error: "invalid_grant",
          error_description: "Invalid or expired authorization code",
        },
        400,
      );
    }

    const authData = JSON.parse(codeData);
    
    console.log("Found authorization code data:", {
      hasSessionJWT: !!authData.sessionJWT,
      hasCodeChallenge: !!authData.codeChallenge,
      codeChallengeMethod: authData.codeChallengeMethod,
      clientId: authData.clientId,
    });

    // OAuth 2.1 PKCE Verification
    if (!authData.codeChallenge || authData.codeChallengeMethod !== "S256") {
      console.error("Invalid PKCE challenge method:", {
        hasCodeChallenge: !!authData.codeChallenge,
        method: authData.codeChallengeMethod,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "Invalid PKCE challenge method",
        },
        400,
      );
    }

    // Verify code verifier against challenge
    const computedChallenge = await generateCodeChallenge(codeVerifier);
    console.log("PKCE verification:", {
      computedChallenge: computedChallenge.substring(0, 10) + "...",
      storedChallenge: authData.codeChallenge.substring(0, 10) + "...",
      matches: computedChallenge === authData.codeChallenge,
    });
    
    if (computedChallenge !== authData.codeChallenge) {
      console.error("PKCE verification failed:", {
        computed: computedChallenge,
        stored: authData.codeChallenge,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        },
        400,
      );
    }

    // Clean up the authorization code immediately to prevent reuse
    await c.env.AUTH_STORE.delete(`auth_code:${authCode}`);
    
    console.log("Token exchange successful:", {
      authCode: authCode.substring(0, 20) + "...",
      tokenLength: authData.sessionJWT?.length,
      scope: authData.scope,
    });

    // Return the JWT as access token
    const tokenResponse = {
      access_token: authData.sessionJWT,
      token_type: "Bearer",
      expires_in: 86400, // 24 hours
      scope: authData.scope,
    };
    
    console.log("Returning token response:", {
      hasAccessToken: !!tokenResponse.access_token,
      tokenType: tokenResponse.token_type,
      expiresIn: tokenResponse.expires_in,
    });
    
    return c.json(tokenResponse);
  } catch (error) {
    console.error("Token exchange error:", error);
    return c.json(
      {
        error: "server_error",
        error_description: "Failed to exchange authorization code",
      },
      500,
    );
  }
});

// Remove the hardcoded root route - let ASSETS handle it

// SSE Transport endpoint (backwards compatibility) with bearer token auth
app.use("/sse/*", stytchBearerTokenAuthMiddleware);
app.all("/sse", async (c) => {
  // Get authenticated user context
  const userContext = c.get('userContext') as UserContext;
  const userId = userContext?.userId || 'anonymous';
  
  // Get user-specific MCP Durable Object instance
  const id = c.env.MCP_OBJECT.idFromName(`mcp:${userId}`);
  const stub = c.env.MCP_OBJECT.get(id);
  
  // Forward the request to the Durable Object
  return await stub.fetch(c.req.raw);
});

// HTTP Streaming Transport endpoint (preferred) with bearer token auth
app.use("/mcp/*", stytchBearerTokenAuthMiddleware);
app.all("/mcp", async (c) => {
  // Get authenticated user context
  const userContext = c.get('userContext') as UserContext;
  const userId = userContext?.userId || 'anonymous';
  
  console.log("MCP request for user:", {
    userId,
    email: userContext?.email,
    method: c.req.method,
    url: c.req.url,
  });
  
  // Get user-specific MCP Durable Object instance
  const id = c.env.MCP_OBJECT.idFromName(`mcp:${userId}`);
  const stub = c.env.MCP_OBJECT.get(id);
  
  // The McpAgent expects the raw request
  // Pass auth context via the execution context instead of modifying the request
  const ctx = c.executionCtx as any;
  ctx.waitUntil(Promise.resolve()); // Ensure context is available
  
  // Set props on the context for the McpAgent to use
  if (!ctx.props) {
    ctx.props = {};
  }
  ctx.props.claims = {
    sub: userContext.userId,
    email: userContext.email,
  };
  ctx.props.accessToken = c.req.header('authorization')?.substring(7) || '';
  
  // Forward the original request to the Durable Object
  // The McpAgent will handle the transport detection internally
  return await stub.fetch(c.req.raw);
});

// Health check
app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// Serve static assets from Vite (must be last)
app.mount("/", (req, env) => env.ASSETS.fetch(req));

// Export the MCP Durable Object class (renamed for wrangler config)
export { CalendarMCP as MCP };

// Export default handler - all requests go through Hono app
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // All requests go to Hono app for proper routing and authentication
    return app.fetch(request, env, ctx);
  },
};

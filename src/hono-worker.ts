import { Hono } from "hono";
import { cors } from "hono/cors";

// Environment interface for Cloudflare Worker
interface Env {
	AUTH_STORE: KVNamespace;
	MCP_OBJECT: DurableObjectNamespace;
	STYTCH_PROJECT_ID: string;
	STYTCH_SECRET_KEY: string;
	STYTCH_PUBLIC_TOKEN: string;
	STYTCH_PROJECT_ENV: string;
	FRONTEND_URL: string;
}

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// Add CORS middleware
app.use("/*", cors({
	origin: "*",
	allowHeaders: ["Authorization", "Content-Type"],
	allowMethods: ["GET", "POST", "OPTIONS"],
}));

// OAuth 2.0 Discovery endpoints (no auth required)
app.get("/.well-known/oauth-protected-resource", async (c) => {
	const url = new URL(c.req.url);
	const baseUrl = `${url.protocol}//${url.host}`;
	
	// RFC 9728 - Protected Resource Metadata
	const metadata = {
		resource: baseUrl,
		authorization_servers: [baseUrl], // This server acts as both resource and authorization server
		scopes_supported: [
			"mcp:exec:tools.subscribe_calendar",
			"mcp:exec:tools.unsubscribe_calendar", 
			"mcp:exec:tools.list_calendars",
			"mcp:exec:tools.search_events",
			"mcp:exec:tools.get_events",
			"mcp:exec:tools.get_daily_agenda",
			"mcp:exec:tools.get_upcoming_events",
			"mcp:exec:tools.*", // All calendar tools
			"mcp:read:resources.calendars",
			"openid",
			"profile", 
			"email"
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
	
	const stytchApiDomain = c.env.STYTCH_PROJECT_ENV === "live" 
		? "https://api.stytch.com" 
		: "https://login-test.srv.im";
	
	// RFC 8414 - Authorization Server Metadata (OAuth 2.1 compliant)
	const metadata = {
		issuer: baseUrl,
		authorization_endpoint: `${baseUrl}/oauth/authorize`,
		token_endpoint: `${baseUrl}/oauth2/token`,
		userinfo_endpoint: `${stytchApiDomain}/v1/sessions/authenticate`,
		jwks_uri: `${stytchApiDomain}/v1/sessions/jwks/${c.env.STYTCH_PROJECT_ID}`,
		scopes_supported: [
			"mcp:exec:tools.subscribe_calendar",
			"mcp:exec:tools.unsubscribe_calendar", 
			"mcp:exec:tools.list_calendars",
			"mcp:exec:tools.search_events",
			"mcp:exec:tools.get_events",
			"mcp:exec:tools.get_daily_agenda",
			"mcp:exec:tools.get_upcoming_events",
			"mcp:exec:tools.*",
			"mcp:read:resources.calendars",
			"openid",
			"profile", 
			"email"
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
	};
	
	return c.json(metadata);
});

// Generate PKCE code verifier and challenge
async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

// Simple authorization endpoint - redirect directly to Stytch
app.get("/oauth/authorize", async (c) => {
	const clientId = c.req.query("client_id");
	const redirectUri = c.req.query("redirect_uri");
	const scope = c.req.query("scope");
	const state = c.req.query("state");
	const codeChallenge = c.req.query("code_challenge");
	const codeChallengeMethod = c.req.query("code_challenge_method");
	
	// OAuth 2.1 requires PKCE for all clients
	if (!codeChallenge || codeChallengeMethod !== "S256") {
		return c.json({ 
			error: "invalid_request", 
			error_description: "PKCE with S256 code challenge method is required" 
		}, 400);
	}
	
	// OAuth 2.1 requires state parameter
	if (!state) {
		return c.json({ 
			error: "invalid_request", 
			error_description: "State parameter is required" 
		}, 400);
	}
	
	if (!clientId || !redirectUri) {
		return c.json({ error: "invalid_request", error_description: "Missing client_id or redirect_uri" }, 400);
	}
	
	// Redirect URI validation is handled by Stytch's Dynamic Client Registration
	
	// Store the original request parameters in KV for the callback
	const requestId = `oauth_req_${Date.now()}_${Math.random().toString(36).substring(2)}`;
	await c.env.AUTH_STORE.put(`oauth_request:${requestId}`, JSON.stringify({
		clientId,
		redirectUri,
		scope: scope || "read:calendars manage:calendars read:events",
		state,
		codeChallenge,
		codeChallengeMethod,
		createdAt: Date.now()
	}), { expirationTtl: 600 }); // 10 minutes
	
	// Redirect to Stytch OAuth with our callback URL
	// Use the correct Stytch OAuth domain (not API domain)
	const stytchOAuthDomain = c.env.STYTCH_PROJECT_ENV === 'live' 
		? 'https://login.stytch.com' 
		: 'https://login-test.srv.im';
		
	// Use static callback URL and pass requestId via state parameter
	const baseCallbackUrl = `${new URL(c.req.url).origin}/oauth/callback`;
	
	const stytchUrl = `${stytchOAuthDomain}/v1/public/oauth/github/start?` + 
		new URLSearchParams({
			public_token: c.env.STYTCH_PUBLIC_TOKEN,
			login_redirect_url: baseCallbackUrl,
			signup_redirect_url: baseCallbackUrl,
			state: requestId // Pass requestId as state parameter
		}).toString();
	
	return c.redirect(stytchUrl);
});

// OAuth callback from Stytch
app.get("/oauth/callback", async (c) => {
	const token = c.req.query("stytch_token");
	const requestId = c.req.query("state"); // requestId is now in state parameter
	
	if (!token || !requestId) {
		return c.html(`<h2>Error</h2><p>Missing authentication token or state parameter</p>`, 400);
	}
	
	try {
		// Get the original OAuth request
		const requestData = await c.env.AUTH_STORE.get(`oauth_request:${requestId}`);
		if (!requestData) {
			return c.html(`<h2>Error</h2><p>OAuth request expired or not found</p>`, 400);
		}
		
		const oauthRequest = JSON.parse(requestData);
		
		// Authenticate the Stytch token to get a JWT
		const stytchApiDomain = c.env.STYTCH_PROJECT_ENV === 'live' ? 'https://api.stytch.com' : 'https://login-test.srv.im';
		const stytchResponse = await fetch(`${stytchApiDomain}/v1/oauth/authenticate`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${btoa(`${c.env.STYTCH_PROJECT_ID}:${c.env.STYTCH_SECRET_KEY}`)}`
			},
			body: JSON.stringify({
				token,
				session_duration_minutes: 1440 // 24 hours
			})
		});
		
		if (!stytchResponse.ok) {
			throw new Error(`Stytch authentication failed: ${stytchResponse.statusText}`);
		}
		
		const stytchData = await stytchResponse.json() as { session_jwt: string };
		const sessionJWT = stytchData.session_jwt;
		
		// Generate authorization code
		const authCode = `auth_${Date.now()}_${Math.random().toString(36).substring(2)}`;
		
		// Store the authorization code mapping with PKCE challenge
		await c.env.AUTH_STORE.put(`auth_code:${authCode}`, JSON.stringify({
			sessionJWT,
			clientId: oauthRequest.clientId,
			scope: oauthRequest.scope,
			codeChallenge: oauthRequest.codeChallenge,
			codeChallengeMethod: oauthRequest.codeChallengeMethod,
			createdAt: Date.now()
		}), { expirationTtl: 300 }); // 5 minutes
		
		// Clean up the request
		await c.env.AUTH_STORE.delete(`oauth_request:${requestId}`);
		
		// Redirect back to the original client with authorization code
		const callbackUrl = new URL(oauthRequest.redirectUri);
		callbackUrl.searchParams.set("code", authCode);
		if (oauthRequest.state) {
			callbackUrl.searchParams.set("state", oauthRequest.state);
		}
		
		return c.redirect(callbackUrl.toString());
		
	} catch (error) {
		console.error("OAuth callback error:", error);
		return c.html(`<h2>Authentication Failed</h2><p>Unable to complete OAuth flow</p>`, 500);
	}
});

// Token exchange endpoint
app.post("/oauth2/token", async (c) => {
	const formData = await c.req.formData();
	const grantType = formData.get("grant_type");
	const authCode = formData.get("code");
	const codeVerifier = formData.get("code_verifier");
	
	if (grantType !== "authorization_code" || !authCode) {
		return c.json({
			error: "invalid_request",
			error_description: "Invalid grant_type or missing code"
		}, 400);
	}
	
	// OAuth 2.1 requires PKCE code verifier
	if (!codeVerifier || typeof codeVerifier !== 'string') {
		return c.json({
			error: "invalid_request",
			error_description: "PKCE code verifier is required and must be a string"
		}, 400);
	}
	
	try {
		// Get the authorization code data
		const codeData = await c.env.AUTH_STORE.get(`auth_code:${authCode}`);
		if (!codeData) {
			return c.json({
				error: "invalid_grant",
				error_description: "Invalid or expired authorization code"
			}, 400);
		}
		
		const authData = JSON.parse(codeData);
		
		// OAuth 2.1 PKCE Verification
		if (!authData.codeChallenge || authData.codeChallengeMethod !== "S256") {
			return c.json({
				error: "invalid_grant",
				error_description: "Invalid PKCE challenge method"
			}, 400);
		}
		
		// Verify code verifier against challenge
		const computedChallenge = await generateCodeChallenge(codeVerifier);
		if (computedChallenge !== authData.codeChallenge) {
			return c.json({
				error: "invalid_grant",
				error_description: "PKCE verification failed"
			}, 400);
		}
		
		// Clean up the authorization code
		await c.env.AUTH_STORE.delete(`auth_code:${authCode}`);
		
		// Return the JWT as access token
		return c.json({
			access_token: authData.sessionJWT,
			token_type: "Bearer",
			expires_in: 86400, // 24 hours
			scope: authData.scope
		});
		
	} catch (error) {
		console.error("Token exchange error:", error);
		return c.json({
			error: "server_error",
			error_description: "Failed to exchange authorization code"
		}, 500);
	}
});

// Web dashboard (basic info)
app.get("/", async (c) => {
	return c.html(`
		<h1>iCal MCP Server Dashboard</h1>
		<p>Welcome! This server provides calendar tools via the MCP protocol.</p>
		<p>Connect via MCP client at: <code>${new URL(c.req.url).origin}/mcp</code></p>
	`);
});

// MCP SSE endpoint (basic authentication will be handled by the MCP agent)
app.get("/sse", async (c) => {
	// Get user-specific MCP Durable Object
	const userId = (c.executionCtx as any).props?.claims?.sub;
	const id = c.env.MCP_OBJECT.idFromName(`mcp:${userId}`);
	const stub = c.env.MCP_OBJECT.get(id);
	
	// Forward the request to the Durable Object with authentication context
	return await stub.fetch(c.req.raw);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

export default app;
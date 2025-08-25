import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";

/**
 * Validate if token has required scope for MCP operation
 */
function validateScope(tokenScope: string | undefined, requiredScope: string): boolean {
	if (!tokenScope) return false;
	
	const scopes = tokenScope.split(' ');
	
	// Check for exact scope match
	if (scopes.includes(requiredScope)) return true;
	
	// Check for wildcard scope (e.g., "mcp:exec:tools.*" covers "mcp:exec:tools.subscribe_calendar")
	for (const scope of scopes) {
		if (scope.endsWith('.*')) {
			const baseScope = scope.slice(0, -2); // Remove ".*"
			if (requiredScope.startsWith(baseScope)) return true;
		}
	}
	
	return false;
}

/**
 * stytchSessionAuthMiddleware is a Hono middleware that validates that the user is logged in
 * It checks for the stytch_session_jwt cookie set by the Stytch FE SDK
 */
export const stytchSessionAuthMiddleware = createMiddleware<{
	Variables: {
		userID: string;
	};
	Bindings: Env;
}>(async (c, next) => {
	const sessionCookie = getCookie(c, "stytch_session_jwt");

	try {
		const verifyResult = await validateStytchJWT(sessionCookie ?? "", c.env);
		c.set("userID", verifyResult.payload.sub!);
	} catch (error) {
		console.error("Session auth failed:", error);
		throw new HTTPException(401, { message: "Unauthenticated" });
	}

	await next();
});

/**
 * stytchBearerTokenAuthMiddleware is a Hono middleware that validates that the request has a Stytch-issued bearer token
 * Tokens are issued to clients at the end of a successful OAuth flow
 */
export const stytchBearerTokenAuthMiddleware = createMiddleware<{
	Bindings: Env;
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	const url = new URL(c.req.url);

	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		const wwwAuthValue = `Bearer error="Unauthorized", error_description="Unauthorized", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`;
		const responseHeaders = new Headers();

		responseHeaders.set("WWW-Authenticate", wwwAuthValue);
		responseHeaders.set("Access-Control-Allow-Origin", "*");
		const res = new Response(null, { status: 401, headers: responseHeaders });
		throw new HTTPException(401, {
			message: "Missing or invalid access token",
			res: res,
		});
	}
	const accessToken = authHeader.substring(7);

	try {
		const verifyResult = await validateStytchJWT(accessToken, c.env);
		// Adding authentication context to execution context - props don't exist in types but are used by MCP
		(c.executionCtx as any).props = {
			claims: verifyResult.payload,
			accessToken,
		};
	} catch (error) {
		console.error("Bearer token auth failed:", error);
		const wwwAuthValue = `Bearer error="invalid_token", error_description="The access token provided is expired, revoked, malformed, or invalid", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`;
		const responseHeaders = new Headers();
		responseHeaders.set("WWW-Authenticate", wwwAuthValue);
		responseHeaders.set("Access-Control-Allow-Origin", "*");
		const res = new Response(null, { status: 401, headers: responseHeaders });
		throw new HTTPException(401, { message: "Invalid access token", res: res });
	}

	await next();
});

/**
 * Create a middleware that validates both bearer token and required MCP scope
 */
export const createMcpScopeMiddleware = (requiredScope: string) => createMiddleware<{
	Bindings: Env;
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	const url = new URL(c.req.url);

	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		const wwwAuthValue = `Bearer error="insufficient_scope", error_description="The request requires higher privileges than provided by the access token", scope="${requiredScope}", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`;
		const responseHeaders = new Headers();
		responseHeaders.set("WWW-Authenticate", wwwAuthValue);
		responseHeaders.set("Access-Control-Allow-Origin", "*");
		const res = new Response(null, { status: 403, headers: responseHeaders });
		throw new HTTPException(403, {
			message: "Insufficient scope",
			res: res,
		});
	}
	
	const accessToken = authHeader.substring(7);

	try {
		const verifyResult = await validateStytchJWT(accessToken, c.env);
		const tokenScope = verifyResult.payload.scope as string;
		
		// Validate scope
		if (!validateScope(tokenScope, requiredScope)) {
			const wwwAuthValue = `Bearer error="insufficient_scope", error_description="The request requires higher privileges than provided by the access token", scope="${requiredScope}", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`;
			const responseHeaders = new Headers();
			responseHeaders.set("WWW-Authenticate", wwwAuthValue);
			responseHeaders.set("Access-Control-Allow-Origin", "*");
			const res = new Response(null, { status: 403, headers: responseHeaders });
			throw new HTTPException(403, {
				message: "Insufficient scope",
				res: res,
			});
		}
		
		// Adding authentication context to execution context
		(c.executionCtx as any).props = {
			claims: verifyResult.payload,
			accessToken,
		};
	} catch (error) {
		console.error("MCP scope auth failed:", error);
		const wwwAuthValue = `Bearer error="invalid_token", error_description="The access token provided is expired, revoked, malformed, or invalid", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`;
		const responseHeaders = new Headers();
		responseHeaders.set("WWW-Authenticate", wwwAuthValue);
		responseHeaders.set("Access-Control-Allow-Origin", "*");
		const res = new Response(null, { status: 401, headers: responseHeaders });
		throw new HTTPException(401, { message: "Invalid access token", res: res });
	}

	await next();
});

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function validateStytchJWT(token: string, env: Env) {
	if (!token) {
		throw new Error("No token provided");
	}

	if (!jwks) {
		// Build JWKS URL based on environment
		const stytchDomain = env.STYTCH_PROJECT_ENV === "live" 
			? "https://api.stytch.com" 
			: "https://login-test.srv.im";
		jwks = createRemoteJWKSet(new URL(`${stytchDomain}/v1/sessions/jwks/${env.STYTCH_PROJECT_ID}`));
	}

	return await jwtVerify(token, jwks, {
		audience: env.STYTCH_PROJECT_ID,
		issuer: env.STYTCH_PROJECT_ENV === "live" 
			? ["stytch.com/api"] 
			: ["stytch.com/test"],
		typ: "JWT",
		algorithms: ["RS256"],
	});
}
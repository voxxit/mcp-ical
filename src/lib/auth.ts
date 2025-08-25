import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";

/**
 * Stytch session authentication middleware - validates session JWT cookie
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
    console.error(error);
    throw new HTTPException(401, { message: "Unauthenticated" });
  }

  await next();
});

/**
 * Stytch bearer token authentication middleware - validates OAuth bearer tokens
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
    const res = new Response(null, { status: 401, headers: responseHeaders });
    throw new HTTPException(401, { message: "Missing or invalid access token", res });
  }
  
  const accessToken = authHeader.substring(7);

  try {
    const verifyResult = await validateStytchJWT(accessToken, c.env);
    
    // Extract user information from JWT payload
    const userContext = {
      userId: verifyResult.payload.sub || 'anonymous',
      email: verifyResult.payload['https://stytch.com/session']?.attributes?.user_agent || '',
      sessionId: verifyResult.payload['https://stytch.com/session']?.id || '',
      scopes: ['read:calendars', 'manage:calendars', 'read:events'],
    };
    
    // Set user context for the request
    c.set('userContext', userContext);
    
    // Also pass authentication context to MCP Agent
    // @ts-ignore Props pattern from agents library
    c.executionCtx.props = {
      claims: verifyResult.payload,
      accessToken,
    };
  } catch (error) {
    console.error(error);
    throw new HTTPException(401, { message: "Unauthenticated" });
  }

  await next();
});

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function validateStytchJWT(token: string, env: Env) {
  const stytchDomain = env.STYTCH_DOMAIN || "https://test.stytch.com";
  
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${stytchDomain}/.well-known/jwks.json`));
  }

  // Stytch JWTs have issuer format: "stytch.com/{project_id}"
  const expectedIssuer = `stytch.com/${env.STYTCH_PROJECT_ID}`;
  
  console.log("JWT validation config:", {
    expectedIssuer,
    audience: env.STYTCH_PROJECT_ID,
    jwksUrl: `${stytchDomain}/.well-known/jwks.json`,
  });

  return await jwtVerify(token, jwks, {
    audience: env.STYTCH_PROJECT_ID,
    issuer: [expectedIssuer], // Use the correct issuer format
    typ: "JWT",
    algorithms: ["RS256"],
  });
}
/**
 * Test library and framework: Jest (describe/it/expect, jest.mock).
 * These tests target the implementation in src/clerk-auth[.ts], specifically the diff contents provided.
 * External dependencies (@clerk/backend) are mocked. We also polyfill btoa/atob for Node.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// IMPORTANT: Adjust this import to the implementation file path. The script sets it to IMPORT_PATH placeholder.
import { ClerkHandler, type ClerkEnv } from "src/clerk-auth";

// Mock @clerk/backend
jest.mock("@clerk/backend", () => {
  return {
    createClerkClient: jest.fn(() => ({
      users: {
        getUser: jest.fn(async (userId: string) => ({
          id: userId,
          emailAddresses: [{ emailAddress: "user@example.com" }],
        })),
      },
    })),
    verifyToken: jest.fn(async (token: string, opts: any) => ({
      sub: "user_123",
      sid: "sess_abc",
    })),
  };
});

const { createClerkClient, verifyToken } = require("@clerk/backend");

// Minimal Request-like helper: the code only calls request.headers.get(name)
const makeRequest = (headers: Record<string, string>): Request => {
  const h = new Map<string, string>(Object.entries(headers));
  const reqLike = {
    headers: {
      get: (name: string) => h.get(name) ?? null,
    },
  } as unknown as Request;
  return reqLike;
};

const base64Encode = (str: string) => Buffer.from(str, "utf8").toString("base64");
const base64Decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

describe("ClerkHandler", () => {
  const env: ClerkEnv = {
    CLERK_SECRET_KEY: "sk_test_very_secret_key",
    // Shape: "pk_<env>_<domain>[$rest]" so domain extraction works
    CLERK_PUBLISHABLE_KEY: "pk_test_exampleDomain$rest",
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2025-01-01T00:00:00Z"));
    jest.clearAllMocks();

    // Polyfill btoa/atob for Node
    // @ts-expect-error assign global
    globalThis.btoa = (s: string) => base64Encode(s);
    // @ts-expect-error assign global
    globalThis.atob = (s: string) => base64Decode(s);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("verifyRequest", () => {
    it("returns isValid=false when no token is present in headers or cookies", async () => {
      const handler = new ClerkHandler(env);
      const req = makeRequest({});
      const result = await handler.verifyRequest(req);

      expect(result).toEqual({ isValid: false });
      expect(verifyToken).not.toHaveBeenCalled();
    });

    it("uses Authorization Bearer token when provided (header precedence over cookies)", async () => {
      const handler = new ClerkHandler(env);
      const req = makeRequest({
        Authorization: "Bearer headerToken123",
        Cookie: "__clerk_db_jwt=cookieToken456; __session=alt; __client=alt2",
      });

      const result = await handler.verifyRequest(req);

      expect(verifyToken).toHaveBeenCalledTimes(1);
      expect(verifyToken).toHaveBeenCalledWith("headerToken123", expect.objectContaining({
        secretKey: env.CLERK_SECRET_KEY,
        authorizedParties: [
          "https://mcp-ical-server.kiwrlty0dq.workers.dev",
          "http://localhost:8787",
        ],
      }));
      expect(result.isValid).toBe(true);
      expect(result.userId).toBe("user_123");
      expect(result.sessionId).toBe("sess_abc");

      const clerkClient = (createClerkClient as jest.Mock).mock.results[0].value;
      expect(clerkClient.users.getUser).toHaveBeenCalledWith("user_123");
      expect(result.email).toBe("user@example.com");
    });

    it("falls back to __clerk_db_jwt cookie when Authorization header is absent", async () => {
      const handler = new ClerkHandler(env);
      const req = makeRequest({
        Cookie: "__clerk_db_jwt=cookieToken456",
      });

      await handler.verifyRequest(req);
      expect(verifyToken).toHaveBeenCalledWith("cookieToken456", expect.any(Object));
    });

    it("falls back to __session cookie when __clerk_db_jwt is missing", async () => {
      const handler = new ClerkHandler(env);
      const req = makeRequest({
        Cookie: "__session=sessionToken789",
      });

      await handler.verifyRequest(req);
      expect(verifyToken).toHaveBeenCalledWith("sessionToken789", expect.any(Object));
    });

    it("falls back to __client cookie when __clerk_db_jwt and __session are missing", async () => {
      const handler = new ClerkHandler(env);
      const req = makeRequest({
        Cookie: "__client=clientToken999",
      });

      await handler.verifyRequest(req);
      expect(verifyToken).toHaveBeenCalledWith("clientToken999", expect.any(Object));
    });

    it("returns isValid=false if verifyToken throws", async () => {
      (verifyToken as jest.Mock).mockRejectedValueOnce(new Error("invalid token"));
      const handler = new ClerkHandler(env);
      const req = makeRequest({
        Authorization: "Bearer badToken",
      });

      const result = await handler.verifyRequest(req);
      expect(result).toEqual({ isValid: false });
    });

    it("sets email to undefined if Clerk returns no email addresses", async () => {
      (createClerkClient as jest.Mock).mockReturnValueOnce({
        users: {
          getUser: jest.fn(async () => ({ id: "user_123", emailAddresses: [] })),
        },
      });

      const handler = new ClerkHandler(env);
      const req = makeRequest({ Authorization: "Bearer tok" });
      const result = await handler.verifyRequest(req);

      expect(result.isValid).toBe(true);
      expect(result.email).toBeUndefined();
    });
  });

  describe("getLoginUrl", () => {
    it("builds sign-in URL with default redirect to origin/dashboard when returnUrl is not provided", () => {
      const handler = new ClerkHandler(env);
      const url = handler.getLoginUrl("https://app.example.com");
      expect(url).toBe("https://exampleDomain.accounts.dev/sign-in?redirect_url=" + encodeURIComponent("https://app.example.com/dashboard"));
    });

    it("builds sign-in URL with provided returnUrl", () => {
      const handler = new ClerkHandler(env);
      const url = handler.getLoginUrl("https://app.example.com", "https://app.example.com/custom");
      expect(url).toBe("https://exampleDomain.accounts.dev/sign-in?redirect_url=" + encodeURIComponent("https://app.example.com/custom"));
    });
  });

  describe("getSignupUrl", () => {
    it("builds sign-up URL with default redirect to origin/dashboard when returnUrl is not provided", () => {
      const handler = new ClerkHandler(env);
      const url = handler.getSignupUrl("https://app.example.com");
      expect(url).toBe("https://exampleDomain.accounts.dev/sign-up?redirect_url=" + encodeURIComponent("https://app.example.com/dashboard"));
    });

    it("builds sign-up URL with provided returnUrl", () => {
      const handler = new ClerkHandler(env);
      const url = handler.getSignupUrl("https://app.example.com", "https://app.example.com/after");
      expect(url).toBe("https://exampleDomain.accounts.dev/sign-up?redirect_url=" + encodeURIComponent("https://app.example.com/after"));
    });
  });

  describe("MCP token generation and verification", () => {
    it("generateMCPToken produces a token verifiable by verifyMCPToken", async () => {
      const handler = new ClerkHandler(env);

      const token = await handler.generateMCPToken("user_abc");
      const result = await handler.verifyMCPToken(token);

      expect(result).toEqual({ isValid: true, userId: "user_abc" });
    });

    it("verifyMCPToken returns invalid for expired token", async () => {
      const handler = new ClerkHandler(env);

      const expiredPayload = {
        userId: "user_abc",
        iat: Math.floor(Date.now() / 1000) - 1000,
        exp: Math.floor(Date.now() / 1000) - 10,
        iss: "ical-mcp-server",
        type: "mcp-api-token",
      };
      const token = base64Encode(JSON.stringify(expiredPayload)) + "." + base64Encode("sig");
      const result = await handler.verifyMCPToken(token);
      expect(result).toEqual({ isValid: false });
    });

    it("verifyMCPToken returns invalid for wrong issuer or type", async () => {
      const handler = new ClerkHandler(env);

      const badIssuer = {
        userId: "user_abc",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "not-ical",
        type: "mcp-api-token",
      };
      const token1 = base64Encode(JSON.stringify(badIssuer)) + "." + base64Encode("sig");
      await expect(handler.verifyMCPToken(token1)).resolves.toEqual({ isValid: false });

      const badType = { ...badIssuer, iss: "ical-mcp-server", type: "wrong" };
      const token2 = base64Encode(JSON.stringify(badType)) + "." + base64Encode("sig");
      await expect(handler.verifyMCPToken(token2)).resolves.toEqual({ isValid: false });
    });

    it("verifyMCPToken handles malformed tokens gracefully", async () => {
      const handler = new ClerkHandler(env);
      await expect(handler.verifyMCPToken("not-base64")).resolves.toEqual({ isValid: false });
      await expect(handler.verifyMCPToken("abc.def.ghi")).resolves.toEqual({ isValid: false });
      const badJson = Buffer.from("{bad json", "utf8").toString("base64") + ".sig";
      await expect(handler.verifyMCPToken(badJson)).resolves.toEqual({ isValid: false });
    });
  });
});
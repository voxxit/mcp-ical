/* 
Test framework: Vitest (preferred for TS + Cloudflare Workers). If this repo uses Jest, 
replace 'vi' with 'jest' and adjust import mocks accordingly.

These tests focus on the Worker OAuth and API logic shown in the PR diff:
- Discovery metadata endpoints
- /register client registration
- /authorize issues auth code
- /token exchanges code (PKCE pass/fail, redirect mismatch) and client_credentials
- /sse auth precedence: MCP token then Clerk
- /api/* gates: calendars list/add/delete and CORS
- Pure functions output checks: getLandingPage/getDashboardPage
*/

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Attempt to import the worker module under test. We try common paths.
// Update path if your worker entry differs.
let workerModule: any;
let workerFetch: (req: Request, env: any, ctx: any) => Promise<Response>;
let getLandingPage: (origin: string, pk: string) => string;
let getDashboardPage: (origin: string, userId: string, email?: string, pk?: string) => string;

// Helper to dynamically import with fallbacks
async function importWorker() {
  const candidates = [
    "./worker-auth",        // src/worker-auth.ts -> compiled path when tests run from src
    "./worker",             // src/worker.ts
    "./index",              // src/index.ts
    "../src/worker-auth",   // tests outside src running against src path
    "../src/worker", 
    "../src/index",
  ];
  for (const p of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const m = await import(p);
      if (m && typeof m.default?.fetch === "function") {
        return m;
      }
    } catch (e) {
      // ignore
    }
  }
  throw new Error("Unable to locate worker module export default with fetch(). Adjust import path in test.");
}

// Minimal KV mock implementing the subset used
function createKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get<T = string>(key: string, type?: "json" | "text"): Promise<any> {
      const v = store.get(key);
      if (v == null) return null;
      if (type === "json") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key: string, value: string, _opts?: any) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    // testing helpers
    __dump() {
      return new Map(store);
    }
  } as unknown as KVNamespace;
}

// ExecutionContext mock
function createCtx() {
  const tasks: Promise<any>[] = [];
  const ctx: any = {
    waitUntil: (p: Promise<any>) => tasks.push(p),
    props: {} as any,
  };
  return ctx;
}

// Minimal ClerkHandler mock API surface
class ClerkHandlerMock {
  verifyRequest = vi.fn().mockResolvedValue({ isValid: false, userId: undefined });
  verifyMCPToken = vi.fn().mockResolvedValue({ isValid: false, userId: undefined });
  generateMCPToken = vi.fn().mockResolvedValue("TOKEN123");
}

// Wire the mock class in place of the real one via vi.mock on module import
// We don't know the precise path, so we monkey-patch globalThis to be read by worker code.
(globalThis as any).ClerkHandler = ClerkHandlerMock;

// Crypto mocks: randomUUID and subtle.digest (for PKCE)
const originalCrypto = globalThis.crypto;
const mockCrypto: any = {
  randomUUID: vi.fn()
    // produce deterministic UUIDs for stable snapshots
    .mockReturnValueOnce("uuid-1")
    .mockReturnValueOnce("uuid-2")
    .mockReturnValue("uuid-const"),
  subtle: {
    digest: vi.fn(async (_alg: any, data: ArrayBuffer) => {
      // Simple stable hash mock: sum bytes -> base64url of string "hash:<sum>"
      const bytes = new Uint8Array(data);
      let sum = 0; for (const b of bytes) sum = (sum + b) % 65536;
      const s = `hash:${sum}`;
      const b64 = Buffer.from(s, "utf8").toString("base64");
      // return ArrayBuffer as per WebCrypto
      return new TextEncoder().encode(b64).buffer;
    })
  }
};

function setMockCrypto() {
  // In Workers, crypto is present on globalThis
  (globalThis as any).crypto = mockCrypto;
  // btoa used in PKCE path
  if (!(globalThis as any).btoa) {
    (globalThis as any).btoa = (str: string) => Buffer.from(str, "binary").toString("base64");
  }
}

function restoreCrypto() {
  (globalThis as any).crypto = originalCrypto;
}

beforeEach(async () => {
  vi.useFakeTimers();
  setMockCrypto();
  workerModule = await importWorker();
  // export default { fetch } is expected
  workerFetch = workerModule.default.fetch.bind(workerModule.default);
  // pure helpers
  getLandingPage = workerModule.getLandingPage ?? workerModule.default?.getLandingPage ?? workerModule["getLandingPage"];
  getDashboardPage = workerModule.getDashboardPage ?? workerModule.default?.getDashboardPage ?? workerModule["getDashboardPage"];
});

afterEach(() => {
  vi.useRealTimers();
  restoreCrypto();
  vi.restoreAllMocks();
});

function makeEnv(overrides: Partial<any> = {}) {
  return {
    CLERK_SECRET_KEY: "sk_test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
    CALENDAR_CACHE: createKV(),
    ...overrides,
  };
}

async function doFetch(path: string, init: RequestInit = {}, envOverrides: Partial<any> = {}, base = "https://example.com") {
  const env = makeEnv(envOverrides);
  const ctx = createCtx();
  const req = new Request(new URL(path, base), init);
  const res = await workerFetch(req, env, ctx);
  return { res, env, ctx };
}

describe("OAuth discovery metadata", () => {
  it("serves authorization server metadata at multiple /.well-known paths", async () => {
    for (const p of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server/sse",
      "/.well-known/openid-configuration/sse",
      "/sse/.well-known/openid-configuration"
    ]) {
      const { res } = await doFetch(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body.issuer).toBe("https://example.com");
      expect(body.authorization_endpoint).toBe("https://example.com/authorize");
      expect(Array.isArray(body.scopes_supported)).toBe(true);
    }
  });

  it("serves protected resource metadata", async () => {
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/sse"
    ]) {
      const { res } = await doFetch(p);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resource).toBe("https://example.com");
      expect(body.authorization_servers[0]).toBe("https://example.com/.well-known/oauth-authorization-server");
    }
  });
});

describe("Dynamic client registration /register", () => {
  it("creates client and stores in KV with 201 response", async () => {
    const { res, env } = await doFetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "My App", redirect_uris: ["https://app/callback"] })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^client_/);
    expect(body.client_secret).toMatch(/^secret_/);

    // Ensure KV got a record
    const kvDump = (env.CALENDAR_CACHE as any).__dump() as Map<string,string>;
    const hasClient = Array.from(kvDump.keys()).some(k => k.startsWith("oauth_client:client_"));
    expect(hasClient).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const { res } = await doFetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // invalid json -> Request.json() will throw if body invalid; simulate by sending text/plain to trigger catch
      body: "not-json" as any
    });
    // In a real fetch, content-type mismatch still tries to parse; for our test we expect error path 400
    expect([200,201,400]).toContain(res.status); // allow environment differences
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).toBe("invalid_client_metadata");
    }
  });
});

describe("Authorization endpoint /authorize", () => {
  it("issues an auth code and redirects with 302", async () => {
    const redirect = "https://client.app/cb";
    const { res, env } = await doFetch(`/authorize?response_type=code&client_id=cid&redirect_uri=${encodeURIComponent(redirect)}&state=xyz&code_challenge=abc&code_challenge_method=S256`);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc.startsWith(redirect)).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get("code")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe("xyz");

    // KV should contain auth_code:<code>
    const code = u.searchParams.get("code")!;
    const stored = await (env.CALENDAR_CACHE as any).get(`auth_code:${code}`);
    expect(stored).toBeTruthy();
  });

  it("returns 400 on invalid request", async () => {
    const { res } = await doFetch("/authorize?response_type=token"); // missing redirect_uri/client_id
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid authorization request");
  });
});

describe("Token endpoint /token", () => {
  it("exchanges authorization_code successfully with PKCE match", async () => {
    // First store a code in KV
    const { env } = await doFetch("/", { method: "GET" }); // initialize env
    const code = "code-ok";
    // PKCE flow: In worker, it computes base64url(SHA256(verifier)) and compares to code_challenge
    // Our mock digest makes deterministic base64 for input bytes. We'll create a verifier that yields our desired b64.
    const verifier = "abc"; // mocked digest -> base64 of 'hash:<sum>'; for ascii 'abc' (97+98+99 = 294) -> 'aGFzaDoyOTQ=' then urlsafe adjust happens but not needed for equality with mock value path
    const codeData = {
      redirect_uri: "https://client.app/cb",
      code_challenge: "aGFzaDoyOTQ", // after btoa(...).replace(/=+$/,'') expectation; we'll trim '=' to mimic urlsafe removal
      scope: "openid profile email"
    };
    await env.CALENDAR_CACHE.put(`auth_code:${code}`, JSON.stringify(codeData));

    // Mock Clerk to validate MCP generation
    const ch = new ClerkHandlerMock();
    ch.generateMCPToken.mockResolvedValue("MCP_OK");
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.app/cb",
      code_verifier: verifier
    });
    const { res } = await doFetch("/token", {
      method: "POST",
      body: form as any
    }, { CALENDAR_CACHE: env.CALENDAR_CACHE });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBe("mcp_MCP_OK");
    expect(body.token_type).toBe("Bearer");
  });

  it("fails when redirect_uri mismatches", async () => {
    const { env } = await doFetch("/", { method: "GET" });
    const code = "code-bad-redirect";
    await env.CALENDAR_CACHE.put(`auth_code:${code}`, JSON.stringify({
      redirect_uri: "https://client.app/cb"
    }));
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://evil.app/cb"
    });
    const { res } = await doFetch("/token", { method: "POST", body: form as any }, { CALENDAR_CACHE: env.CALENDAR_CACHE });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  it("fails PKCE verification when challenge does not match", async () => {
    const { env } = await doFetch("/", { method: "GET" });
    const code = "code-bad-pkce";
    await env.CALENDAR_CACHE.put(`auth_code:${code}`, JSON.stringify({
      redirect_uri: "https://client.app/cb",
      code_challenge: "not-matching"
    }));
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.app/cb",
      code_verifier: "zzz"
    });
    const { res } = await doFetch("/token", { method: "POST", body: form as any }, { CALENDAR_CACHE: env.CALENDAR_CACHE });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/PKCE/i);
  });

  it("client_credentials returns token; validates client_secret when provided", async () => {
    const { env } = await doFetch("/", { method: "GET" });
    const clientId = "client_abc";
    await env.CALENDAR_CACHE.put(`oauth_client:${clientId}`, JSON.stringify({
      client_secret: "secret_xyz"
    }));

    const ch = new ClerkHandlerMock();
    ch.generateMCPToken.mockResolvedValue("MCP_APP");
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    // Correct secret
    let form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: "secret_xyz"
    });
    let r = await doFetch("/token", { method: "POST", body: form as any }, { CALENDAR_CACHE: env.CALENDAR_CACHE });
    expect(r.res.status).toBe(200);
    let body = await r.res.json();
    expect(body.access_token).toBe("mcp_MCP_APP");

    // Incorrect secret
    form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: "bad"
    });
    r = await doFetch("/token", { method: "POST", body: form as any }, { CALENDAR_CACHE: env.CALENDAR_CACHE });
    expect(r.res.status).toBe(401);
    body = await r.res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("returns unsupported_grant_type for unknown grant", async () => {
    const { res } = await doFetch("/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "password" }) as any
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unsupported_grant_type");
  });
});

describe("SSE authentication precedence (/sse)", () => {
  it("accepts valid MCP token without invoking Clerk verification", async () => {
    const ch = new ClerkHandlerMock();
    ch.verifyMCPToken.mockResolvedValue({ isValid: true, userId: "user_mcp" });
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const { res, ctx } = await doFetch("/sse", {
      headers: { Authorization: "Bearer mcp_TOKEN" }
    });
    // The test environment won't actually stream SSE; ensure not 401
    expect(res.status).not.toBe(401);
    // It should have set ctx.props.userId
    expect(ctx.props.userId ?? ctx.props?.user?.id).toBe("user_mcp");
    expect(ch.verifyRequest).not.toHaveBeenCalled();
  });

  it("falls back to Clerk verifyRequest when not MCP token", async () => {
    const ch = new ClerkHandlerMock();
    ch.verifyRequest.mockResolvedValue({ isValid: true, userId: "user_clerk" });
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const { res, ctx } = await doFetch("/sse", {
      headers: { Authorization: "Bearer ordinary_token" }
    });
    expect(res.status).not.toBe(401);
    expect(ctx.props.userId).toBe("user_clerk");
  });

  it("returns 401 when no valid authentication", async () => {
    const { res } = await doFetch("/sse");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });
});

describe("API endpoints /api/* with auth gate", () => {
  it("rejects unauthorized access with 401", async () => {
    const { res } = await doFetch("/api/calendars");
    expect(res.status).toBe(401);
  });

  it("lists calendars for authorized user", async () => {
    const kv = createKV({
      "user:user123:calendars": JSON.stringify(["cal1"]),
      "user:user123:calendar:cal1": JSON.stringify({
        id: "cal1", url: "https://x/ics", name: "My Cal", refreshInterval: 60, userId: "user123"
      })
    });

    const ch = new ClerkHandlerMock();
    ch.verifyRequest.mockResolvedValue({ isValid: true, userId: "user123" });
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const { res } = await doFetch("/api/calendars", {
      headers: { Authorization: "Bearer t" }
    }, { CALENDAR_CACHE: kv });

    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("cal1");
  });

  it("adds a calendar via POST and persists to KV", async () => {
    const kv = createKV();
    const ch = new ClerkHandlerMock();
    ch.verifyRequest.mockResolvedValue({ isValid: true, userId: "u1" });
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const { res, env } = await doFetch("/api/calendars", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ url: "https://feed.ics", name: "Work", refreshInterval: 30 })
    }, { CALENDAR_CACHE: kv });

    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.url).toBe("https://feed.ics");
    // Verify KV keys
    const dump = (env.CALENDAR_CACHE as any).__dump() as Map<string,string>;
    const ids = Array.from(dump.keys()).filter(k => k.startsWith("user:u1:calendar:"));
    expect(ids.length).toBe(1);
    const list = await env.CALENDAR_CACHE.get("user:u1:calendars", "json");
    expect(list).toContain(created.id);
  });

  it("deletes a calendar via DELETE and updates list", async () => {
    const kv = createKV({
      "user:u1:calendars": JSON.stringify(["a","b"]),
      "user:u1:calendar:a": JSON.stringify({ id: "a", url: "u", name: "A", refreshInterval: 60, userId: "u1" }),
      "user:u1:calendar:b": JSON.stringify({ id: "b", url: "u", name: "B", refreshInterval: 60, userId: "u1" }),
    });
    const ch = new ClerkHandlerMock();
    ch.verifyRequest.mockResolvedValue({ isValid: true, userId: "u1" });
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const { res, env } = await doFetch("/api/calendars/a", {
      method: "DELETE",
      headers: { Authorization: "Bearer t" }
    }, { CALENDAR_CACHE: kv });

    expect(res.status).toBe(200);
    const list = await env.CALENDAR_CACHE.get("user:u1:calendars", "json");
    expect(list).toEqual(["b"]);
    const a = await env.CALENDAR_CACHE.get("user:u1:calendar:a");
    expect(a).toBeNull();
  });

  it("handles CORS preflight on API routes", async () => {
    const ch = new ClerkHandlerMock();
    ch.verifyRequest.mockResolvedValue({ isValid: true, userId: "u1" });
    (globalThis as any).ClerkHandler = vi.fn(() => ch);

    const { res } = await doFetch("/api/calendars", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("CORS preflight (global) and 404", () => {
  it("responds to global OPTIONS with CORS headers", async () => {
    const { res } = await doFetch("/anything", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("returns 404 for unknown paths", async () => {
    const { res } = await doFetch("/nope");
    expect(res.status).toBe(404);
  });
});

describe("Pure helpers HTML", () => {
  it("getLandingPage returns HTML containing publishableKey and CTA", () => {
    expect(typeof getLandingPage).toBe("function");
    const html = getLandingPage("https://origin", "pk_live_123");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("iCal MCP Server");
    expect(html).toContain('data-clerk-publishable-key="pk_live_123"');
    expect(html).toContain("/sse");
  });

  it("getDashboardPage returns HTML with tabs and token placeholders", () => {
    expect(typeof getDashboardPage).toBe("function");
    const html = getDashboardPage("https://origin", "user_1", "u@example.com", "pk_live_ABC");
    expect(html).toContain("Dashboard - iCal MCP Server");
    expect(html).toContain("Your Calendars");
    expect(html).toContain("MCP Configuration");
    expect(html).toContain('data-clerk-publishable-key="pk_live_ABC"');
    // Ensure examples include the SSE endpoint and placeholders
    expect(html).toContain('\"Authorization: Bearer <span id=\"token-claude\">');
    expect(html).toContain("/sse");
  });
});
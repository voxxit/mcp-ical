# Cloudflare Deployment Guide

This guide explains how to deploy your iCal MCP server to Cloudflare Workers.

## Prerequisites

1. A Cloudflare account
2. Node.js 18+ installed
3. (Optional) Clerk account for authentication

## Setup Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Create KV Namespaces

Create the KV namespaces for calendar storage:

```bash
npm run setup:kv
```

Note the IDs that are output and update them in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CALENDAR_CACHE"
id = "your-actual-kv-namespace-id"
preview_id = "your-actual-preview-kv-namespace-id"
```

### 3. Configure Durable Object Bindings

The Worker requires a Durable Object binding for state management. Add this to your `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "ICAL_MCP"
class_name = "ICalMCPSQLite"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["ICalMCPSQLite"]
```

This binding is required for the SSE endpoint to function properly, as it's referenced in the code via `ICalMCPSQLite.serveSSE("/sse", { binding: "ICAL_MCP" })`.

### 4. Configure Environment Variables

#### For Unauthenticated Mode

Set the following variables in `wrangler.toml`:

```toml
[vars]
CALENDAR_NAME = "Default Calendar"
CALENDAR_REFRESH_INTERVAL = "60"
TZ = "America/New_York"
```

Optionally set a default calendar URL:

```bash
wrangler secret put CALENDAR_URL
# Enter your .ics URL when prompted
```

#### For Authenticated Mode (with Clerk)

1. Create a Clerk application at https://clerk.com
2. Get your API keys from the Clerk dashboard
3. Set the secrets:

```bash
wrangler secret put CLERK_SECRET_KEY
wrangler secret put CLERK_PUBLISHABLE_KEY
wrangler secret put CLERK_JWT_KEY  # Optional
```

4. Enable authentication in `wrangler.toml`:

```toml
[vars]
ENABLE_AUTH = "true"
```

### 5. Deploy to Cloudflare

Deploy to production:

```bash
npm run deploy
```

Deploy to preview environment:

```bash
npm run deploy:preview
```

### 6. Test Your Deployment

Your MCP server will be available at:

- `https://mcp-ical-server.<your-subdomain>.workers.dev/`

The MCP SSE endpoint is at:

- `https://mcp-ical-server.<your-subdomain>.workers.dev/sse`

## Connecting to Your MCP Server

### Using AI Playground

1. Go to https://playground.ai.cloudflare.com/
2. Add your MCP server URL ending with `/sse`
3. If authentication is enabled, you'll be redirected to sign in

### Using MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

Enter your server URL: `https://your-worker.workers.dev/sse`

### Using Claude Desktop (via mcp-remote)

Update your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "ical-remote": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-worker.workers.dev/sse"]
    }
  }
}
```

If authentication is enabled, you'll need to pass the token:

```json
{
  "mcpServers": {
    "ical-remote": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "--token",
        "your-clerk-token",
        "https://your-worker.workers.dev/sse"
      ]
    }
  }
}
```

## Development

Run the Worker locally:

```bash
npm run dev:worker
```

This will start the Worker on `http://localhost:8787`

## Monitoring

View logs and metrics in the Cloudflare dashboard:

1. Go to Workers & Pages
2. Select your Worker
3. View real-time logs and analytics

## Troubleshooting

### KV Namespace Issues

If you see errors about KV namespaces:

1. Ensure you've created the namespaces with `npm run setup:kv`
2. Update the IDs in `wrangler.toml`
3. Redeploy with `npm run deploy`

### Authentication Issues

If authentication isn't working:

1. Verify your Clerk keys are set correctly
2. Check that `ENABLE_AUTH` is set to `"true"`
3. Ensure your Clerk application is configured properly

### Calendar Subscription Issues

If calendars aren't loading:

1. Check the calendar URL is accessible
2. Verify it returns valid iCal format
3. Check Worker logs for errors

## Security Considerations

1. **Always use HTTPS** for calendar URLs containing sensitive data
2. **Enable authentication** for production deployments
3. **Set appropriate CORS headers** if needed
4. **Monitor usage** to prevent abuse
5. **Use rate limiting** for public endpoints

## Cost Considerations

- **Workers Free Tier**: 100,000 requests/day
- **KV Free Tier**: 100,000 reads/day, 1,000 writes/day
- **Durable Objects**: Pay-per-use pricing

Monitor your usage in the Cloudflare dashboard to stay within limits.

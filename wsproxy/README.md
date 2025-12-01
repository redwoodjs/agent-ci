## Bun Discord Gateway WebSocket Proxy

This is a **zero-dependency** Bun-based WebSocket proxy that forwards
traffic between your app (e.g. Cloudflare Workers / Durable Objects)
and the Discord Gateway.

Because the Discord Gateway cannot be accessed directly from a
Cloudflare Worker and will return `401 Unauthorized` in that context
([see Discord docs](https://github.com/discord/discord-api-docs/pull/6246/files#diff-c24665b017972d8f7c266214d30655ea5e105826ef212048f9460632dd61e3dfR97)),
this proxy runs outside Cloudflare and connects to
`wss://gateway.discord.gg` on your behalf.

### Running locally with Bun

```bash
cd wsproxy
bun install   # no dependencies, but sets up the Bun project
bun run proxy.ts
```

The proxy listens on:

- `ws://localhost:3000/gateway`

### Docker

Build the image:

```bash
cd wsproxy
docker build -t machinen-wsproxy .
```

Run the container:

```bash
docker run --rm -p 3000:3000 machinen-wsproxy
```

### Using from Cloudflare Worker / DO

Instead of connecting directly to the Discord Gateway URL
(`wss://gateway.discord.gg/?v=10&encoding=json`), point your Worker /
Durable Object at the proxy:

```ts
const gatewayURL = "ws://your-proxy-host:3000/gateway";
```

Your existing Gateway logic (IDENTIFY, heartbeats, resume, etc.) stays
the same; the proxy just forwards WebSocket frames between your app and
Discord.



const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

type ClientData = {
  upstream: WebSocket | null;
};

const PORT = Number(process.env.PORT || 3000);

const server = Bun.serve<ClientData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // Only upgrade /gateway to WebSocket
    if (url.pathname === "/gateway") {
      const upgraded = server.upgrade(req, {
        data: {
          upstream: null,
        },
      });

      if (upgraded) {
        return;
      }

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("OK (Bun Discord Gateway proxy)", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },

  websocket: {
    open(ws) {
      // When a client connects, create upstream connection to Discord Gateway
      const upstream = new WebSocket(DISCORD_GATEWAY_URL);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        console.log("[proxy] Connected to Discord Gateway");
      });

      upstream.addEventListener("message", (event) => {
        // Forward messages from Discord -> client
        if (ws.readyState === ws.OPEN) {
          ws.send(event.data);
        }
      });

      upstream.addEventListener("close", (event) => {
        console.log(
          `[proxy] Upstream closed: ${event.code} ${event.reason || ""}`
        );

        if (ws.readyState === ws.OPEN || ws.readyState === ws.CLOSING) {
          ws.close(event.code, event.reason);
        }

        ws.data.upstream = null;
      });

      upstream.addEventListener("error", (event) => {
        console.error("[proxy] Upstream error", event);

        if (ws.readyState === ws.OPEN || ws.readyState === ws.CLOSING) {
          ws.close(1011, "Upstream error");
        }

        ws.data.upstream = null;
      });
    },

    message(ws, message) {
      // Forward messages from client -> Discord
      const upstream = ws.data.upstream;

      if (upstream && upstream.readyState === upstream.OPEN) {
        upstream.send(message);
      }
    },

    close(ws, code, reason) {
      const upstream = ws.data.upstream;

      if (upstream && upstream.readyState === upstream.OPEN) {
        upstream.close(code, reason);
      }

      ws.data.upstream = null;
    },

    error(ws, error) {
      console.error("[proxy] Client error", error);

      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === upstream.OPEN) {
        upstream.close(1011, "Client error");
      }

      ws.data.upstream = null;
    },
  },
});

console.log(
  `[proxy] Bun Discord Gateway proxy listening on ws://localhost:${server.port}/gateway`
);



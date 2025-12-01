import { env } from "cloudflare:workers";
import {
  GatewayOpCode,
  GatewayMessage,
  GatewayHello,
  GatewayIdentify,
  GatewayResume,
  GatewayIntent,
  fetchGatewayURL,
} from "../utils/discord-api";
import { handleWebhookEvent } from "../services/webhook-handler";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_BOT_TOKEN: string;
    DISCORD_GATEWAY: DurableObjectNamespace;
  }
}

interface GatewayEnv {
  DISCORD_BOT_TOKEN: string;
}

interface GatewayState {
  sessionId: string | null;
  sequenceNumber: number | null;
  heartbeatInterval: number | null;
  heartbeatAlarmScheduled: boolean;
  connectionStatus: "disconnected" | "connecting" | "connected" | "resuming";
  lastHeartbeatAck: number | null;
  reconnectAttempts: number;
}

export class DiscordGatewayDO {
  private state: DurableObjectState;
  private env: GatewayEnv;
  private ws: WebSocket | null = null;
  private gatewayState: GatewayState = {
    sessionId: null,
    sequenceNumber: null,
    heartbeatInterval: null,
    heartbeatAlarmScheduled: false,
    connectionStatus: "disconnected",
    lastHeartbeatAck: null,
    reconnectAttempts: 0,
  };
  private heartbeatAlarmId: number | null = null;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY_MS = 5000;

  constructor(state: DurableObjectState, env: GatewayEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname;

    // Load state from storage
    await this.loadState();

    if (action === "/start" && request.method === "POST") {
      await this.start();
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } else if (action === "/stop" && request.method === "POST") {
      await this.stop();
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } else if (action === "/status" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: this.gatewayState.connectionStatus,
          sessionId: this.gatewayState.sessionId,
          sequenceNumber: this.gatewayState.sequenceNumber,
          reconnectAttempts: this.gatewayState.reconnectAttempts,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } else if (
      action === "/connect" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      // This is for WebSocket upgrade from external connection
      // We'll handle the WebSocket connection internally
      return new Response("WebSocket upgrade not supported via fetch", {
        status: 400,
      });
    } else {
      return new Response("Not found", { status: 404 });
    }
  }

  private async loadState(): Promise<void> {
    const stored = await this.state.storage.get<GatewayState>("gatewayState");
    if (stored) {
      this.gatewayState = { ...this.gatewayState, ...stored };
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put("gatewayState", this.gatewayState);
  }

  async start(): Promise<void> {
    if (
      this.gatewayState.connectionStatus === "connected" ||
      this.gatewayState.connectionStatus === "connecting"
    ) {
      console.log("[gateway] Already connected or connecting");
      return;
    }

    this.gatewayState.connectionStatus = "connecting";
    await this.saveState();

    try {
      // Fetch Gateway URL
      const gatewayInfo = await fetchGatewayURL();
      console.log("[gateway-debug] gatewayInfo", gatewayInfo);
      console.log(
        "[gateway-debug] DO token prefix",
        this.env.DISCORD_BOT_TOKEN?.slice(0, 10)
      );
      const gatewayURL = gatewayInfo.url;

      // Connect to Gateway WebSocket
      await this.connect(gatewayURL);
    } catch (error) {
      console.error("[gateway] Failed to start:", error);
      this.gatewayState.connectionStatus = "disconnected";
      await this.saveState();
      throw error;
    }
  }

  private async connect(gatewayURL: string): Promise<void> {
    try {
      // Create WebSocket connection
      // Cloudflare Workers support WebSocket connections from Durable Objects
      const wsURL = `${gatewayURL}?v=10&encoding=json`;
      await this.debugGatewayHttp(wsURL);
      console.log(`[gateway] Creating WebSocket connection to ${wsURL}`);
      const ws = new WebSocket(wsURL);

      // Set up event handlers before assigning to this.ws
      ws.addEventListener("open", () => {
        console.log("[gateway] WebSocket connection opened");
        this.gatewayState.connectionStatus = "connecting";
        this.saveState(); // Don't await to avoid blocking
      });

      ws.addEventListener("message", async (event) => {
        try {
          await this.handleMessage(event.data as string);
        } catch (error) {
          console.error("[gateway] Error in message handler:", error);
        }
      });

      ws.addEventListener("error", (event) => {
        const target = event.target as WebSocket | null;
        const anyEvent = event as any;

        console.error("[gateway] WebSocket error", {
          type: event.type,
          url: wsURL,
          readyState: target?.readyState,
          // Some runtimes put a message/error on the event
          message: anyEvent?.message,
          error: anyEvent?.error,
        });
        this.handleDisconnect();
      });

      ws.addEventListener("close", (event) => {
        console.log(
          `[gateway] WebSocket closed: ${event.code} ${event.reason}`
        );
        this.ws = null;
        this.handleDisconnect();
      });

      this.ws = ws;
    } catch (error) {
      console.error("[gateway] Connection error:", error);
      this.gatewayState.connectionStatus = "disconnected";
      await this.saveState();
      throw error;
    }
  }

  private async debugGatewayHttp(url: string): Promise<void> {
    const res = await fetch(url);
    const text = await res.text();
    console.log("[gateway-debug] HTTP gateway test", {
      status: res.status,
      statusText: res.statusText,
      body: text,
    });
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message: GatewayMessage = JSON.parse(data);

      switch (message.op) {
        case GatewayOpCode.DISPATCH:
          await this.handleDispatch(message);
          break;
        case GatewayOpCode.HELLO:
          await this.handleHello(message.d as GatewayHello);
          break;
        case GatewayOpCode.HEARTBEAT_ACK:
          this.handleHeartbeatAck();
          break;
        case GatewayOpCode.RECONNECT:
          await this.handleReconnect();
          break;
        case GatewayOpCode.INVALID_SESSION:
          await this.handleInvalidSession(message.d as boolean);
          break;
        default:
          console.warn(`[gateway] Unhandled op code: ${message.op}`);
      }
    } catch (error) {
      console.error("[gateway] Error handling message:", error);
    }
  }

  private async handleDispatch(message: GatewayMessage): Promise<void> {
    // Update sequence number
    if (message.s !== null && message.s !== undefined) {
      this.gatewayState.sequenceNumber = message.s;
      await this.saveState();
    }

    // Handle READY and RESUMED events (not in GatewayEventType, but part of Gateway protocol)
    const eventType = message.t as string | null;
    if (eventType === "READY" || eventType === "RESUMED") {
      if (eventType === "READY") {
        const readyData = message.d as { session_id: string };
        this.gatewayState.sessionId = readyData.session_id;
        this.gatewayState.connectionStatus = "connected";
        this.gatewayState.reconnectAttempts = 0; // Reset on successful connection
        await this.saveState();
        console.log(
          `[gateway] READY received, session ID: ${readyData.session_id}`
        );
      } else if (eventType === "RESUMED") {
        this.gatewayState.connectionStatus = "connected";
        await this.saveState();
        console.log("[gateway] RESUMED successfully");
      }
      return;
    }

    // Handle other events
    if (eventType) {
      const eventData = message.d;

      // Forward to webhook handler (which handles both webhook and Gateway events)
      await handleWebhookEvent({
        t: eventType,
        d: eventData,
      });
    }
  }

  private async handleHello(hello: GatewayHello): Promise<void> {
    console.log(
      `[gateway] Received HELLO, heartbeat interval: ${hello.heartbeat_interval}ms`
    );

    this.gatewayState.heartbeatInterval = hello.heartbeat_interval;
    await this.saveState();

    // Start heartbeat loop
    await this.startHeartbeat();

    // Send IDENTIFY or RESUME
    if (
      this.gatewayState.sessionId &&
      this.gatewayState.sequenceNumber !== null
    ) {
      await this.sendResume();
    } else {
      await this.sendIdentify();
    }
  }

  private async sendIdentify(): Promise<void> {
    const intents =
      GatewayIntent.GUILDS |
      GatewayIntent.GUILD_MESSAGES |
      GatewayIntent.MESSAGE_CONTENT |
      GatewayIntent.GUILD_MEMBERS;

    const identify: GatewayIdentify = {
      token: this.env.DISCORD_BOT_TOKEN,
      intents,
      properties: {
        os: "cloudflare",
        browser: "machinen",
        device: "machinen",
      },
      compress: false,
    };

    await this.send({
      op: GatewayOpCode.IDENTIFY,
      d: identify,
    });

    console.log("[gateway] Sent IDENTIFY");
  }

  private async sendResume(): Promise<void> {
    if (
      !this.gatewayState.sessionId ||
      this.gatewayState.sequenceNumber === null
    ) {
      await this.sendIdentify();
      return;
    }

    const resume: GatewayResume = {
      token: this.env.DISCORD_BOT_TOKEN,
      session_id: this.gatewayState.sessionId,
      seq: this.gatewayState.sequenceNumber,
    };

    await this.send({
      op: GatewayOpCode.RESUME,
      d: resume,
    });

    this.gatewayState.connectionStatus = "resuming";
    await this.saveState();
    console.log("[gateway] Sent RESUME");
  }

  private async startHeartbeat(): Promise<void> {
    if (this.gatewayState.heartbeatInterval === null) {
      return;
    }

    // Cancel existing alarm if any
    if (this.heartbeatAlarmId !== null) {
      try {
        await this.state.storage.deleteAlarm();
      } catch (e) {
        // Ignore
      }
    }

    // Schedule first heartbeat
    const alarmTime = Date.now() + this.gatewayState.heartbeatInterval;
    await this.state.storage.setAlarm(alarmTime);
    this.gatewayState.heartbeatAlarmScheduled = true;
    await this.saveState();
  }

  async alarm(): Promise<void> {
    // This is called when the alarm fires
    if (
      this.gatewayState.connectionStatus !== "connected" &&
      this.gatewayState.connectionStatus !== "resuming"
    ) {
      return;
    }

    // Check if we received heartbeat ACK
    const now = Date.now();
    if (
      this.gatewayState.lastHeartbeatAck !== null &&
      now - this.gatewayState.lastHeartbeatAck >
        this.gatewayState.heartbeatInterval! * 2
    ) {
      console.warn("[gateway] Heartbeat timeout, reconnecting");
      await this.handleDisconnect();
      return;
    }

    // Send heartbeat
    await this.send({
      op: GatewayOpCode.HEARTBEAT,
      d: this.gatewayState.sequenceNumber,
    });

    // Schedule next heartbeat
    if (this.gatewayState.heartbeatInterval !== null) {
      const alarmTime = Date.now() + this.gatewayState.heartbeatInterval;
      await this.state.storage.setAlarm(alarmTime);
    }
  }

  private handleHeartbeatAck(): void {
    this.gatewayState.lastHeartbeatAck = Date.now();
    this.saveState(); // Don't await to avoid blocking
  }

  private async handleReconnect(): Promise<void> {
    console.log("[gateway] Server requested reconnect");
    await this.handleDisconnect();
    // Reconnection will be handled by handleDisconnect
  }

  private async handleInvalidSession(resumable: boolean): Promise<void> {
    console.log(`[gateway] Invalid session, resumable: ${resumable}`);

    if (!resumable) {
      // Clear session and sequence
      this.gatewayState.sessionId = null;
      this.gatewayState.sequenceNumber = null;
      await this.saveState();
    }

    // Wait a bit before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Reconnect
    await this.handleDisconnect();
  }

  private async handleDisconnect(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // Ignore
      }
      this.ws = null;
    }

    // Cancel heartbeat alarm
    if (this.gatewayState.heartbeatAlarmScheduled) {
      try {
        await this.state.storage.deleteAlarm();
      } catch (e) {
        // Ignore
      }
      this.gatewayState.heartbeatAlarmScheduled = false;
    }

    this.gatewayState.connectionStatus = "disconnected";
    await this.saveState();

    // Attempt reconnection if we haven't exceeded max attempts
    if (this.gatewayState.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.gatewayState.reconnectAttempts++;
      await this.saveState();

      console.log(
        `[gateway] Attempting reconnect (${this.gatewayState.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`
      );

      await new Promise((resolve) =>
        setTimeout(resolve, this.RECONNECT_DELAY_MS)
      );

      try {
        const gatewayInfo = await fetchGatewayURL();
        await this.connect(gatewayInfo.url);
      } catch (error) {
        console.error("[gateway] Reconnection failed:", error);
      }
    } else {
      console.error("[gateway] Max reconnection attempts reached");
    }
  }

  private async send(message: GatewayMessage): Promise<void> {
    if (!this.ws) {
      throw new Error("WebSocket is not initialized");
    }

    // Check if WebSocket is open (readyState 1 = OPEN)
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket is not open (state: ${this.ws.readyState})`);
    }

    this.ws.send(JSON.stringify(message));
  }

  async stop(): Promise<void> {
    this.gatewayState.reconnectAttempts = this.MAX_RECONNECT_ATTEMPTS; // Prevent reconnection
    await this.handleDisconnect();
    console.log("[gateway] Stopped");
  }
}

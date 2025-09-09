"use client";

import { useEffect, useRef } from "react";

import "@xterm/xterm/css/xterm.css";

export default function Term({ containerId }: { containerId: string }) {
  const terminalRef = useRef(null);

  useEffect(() => {
    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      const term = new Terminal();
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.open(terminalRef.current!);
      fitAddon.fit();
      term.focus();

      // Connect to the TTY endpoint through the worker
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//localhost:5173/tasks/${containerId}/term/attach`;

      console.log("url", url);
      console.log("protocol", protocol);

      console.log("opening socket");
      const socket = new WebSocket(url);
      socket.onerror = (event) => {
        console.log("socket error", event);
      };
      socket.onopen = () => {
        console.log("socket opened");
      };
      socket.onclose = (event) => {
        console.log("socket closed", event);
      };

      socket.addEventListener("open", () => {
        console.log("socket opened");

        term.onData((data) => {
          socket.send(data);
        });

        socket.addEventListener("message", (event) => {
          term.write(event.data);
        });
      });
    }

    init();
  }, []);

  return <div ref={terminalRef} />;
}

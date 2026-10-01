// Stand-in for the control server's /v1/control WebSocket. Does exactly two
// things: exchange candidate lists, and give both peers the simultaneous
// "punch now" signal. No auth, no persistence -- throwaway.

import type { ClientMessage, ServerMessage } from "./proto.ts";

const PORT = Number(process.env.PORT ?? 8787);

interface Member {
  name: string;
  ws: any;
  hello?: Extract<ClientMessage, { type: "hello" }>;
}

const rooms = new Map<string, Map<string, Member>>();

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const send = (ws: any, msg: ServerMessage) => ws.send(JSON.stringify(msg));

const server = Bun.serve<{ room?: string; name?: string }>({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req, { data: {} })) return;
    return new Response("wave-mesh M3 spike rendezvous\n");
  },
  websocket: {
    message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: "error", message: "invalid JSON" });
      }

      if (msg.type === "hello") {
        const room = rooms.get(msg.room) ?? new Map<string, Member>();
        rooms.set(msg.room, room);
        if (room.has(msg.name)) return send(ws, { type: "error", message: `name ${msg.name} taken` });

        ws.data.room = msg.room;
        ws.data.name = msg.name;
        room.set(msg.name, { name: msg.name, ws, hello: msg });
        log(`[${msg.room}] ${msg.name} joined | mapping: ${msg.mapping}`);
        for (const c of msg.candidates) log(`[${msg.room}]   candidate ${c.kind} ${c.ip}:${c.port}`);

        const others = [...room.values()].filter((m) => m.name !== msg.name);
        for (const other of others) {
          if (!other.hello) continue;
          send(ws, {
            type: "peer",
            name: other.name,
            candidates: other.hello.candidates,
            mapping: other.hello.mapping,
          });
          send(other.ws, { type: "peer", name: msg.name, candidates: msg.candidates, mapping: msg.mapping });
        }
        if (others.length > 0) {
          // Both sides must start punching at the same time, otherwise the
          // first side's packets hit a NAT that has no state for them yet.
          log(`[${msg.room}] GO -> ${[msg.name, ...others.map((o) => o.name)].join(", ")}`);
          send(ws, { type: "go" });
          for (const other of others) send(other.ws, { type: "go" });
        }
        return;
      }

      if (msg.type === "result") {
        log(`[${ws.data.room}] RESULT ${msg.name}: ${msg.summary}`);
      }
    },
    close(ws) {
      const { room, name } = ws.data;
      if (!room || !name) return;
      const members = rooms.get(room);
      members?.delete(name);
      if (members?.size === 0) rooms.delete(room);
      for (const m of members?.values() ?? []) send(m.ws, { type: "gone", name });
      log(`[${room}] ${name} left`);
    },
  },
});

log(`rendezvous listening on ws://0.0.0.0:${server.port}`);

import { createBunWebSocket } from "hono/bun";

/**
 * The one WebSocket handler of this server.
 *
 * `Bun.serve` takes exactly one `websocket` option, so every socket route has
 * to share it -- which listeners a connection gets is decided when it is
 * upgraded, not by the handler. Two adapters would mean one of them is silently
 * never reached.
 */
export const { upgradeWebSocket, websocket } = createBunWebSocket();

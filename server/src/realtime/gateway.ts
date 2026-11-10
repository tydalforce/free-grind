import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Redis from "ioredis";
import type { WebSocket } from "ws";
import { redis } from "../cache/redis";
import { sendMessage, sendSchema } from "../chat/service";
import { config } from "../config";
import { ApiError } from "../lib/errors";
import { verifySessionJwt } from "../lib/jwt";
import { getTokenVersion } from "../modules/auth/sessions";
import { presenceKey, userChannel } from "./bus";

/**
 * WebSocket gateway at /v1/ws (docs/content/grindr-api/websocket):
 *  - handshake needs Authorization (+ the identity headers our security plugin checks)
 *  - server sends `ws.connection.established` on open
 *  - commands `{type, ref, token, payload}` → `<type>.response {status, ref, payload}`;
 *    an invalid/expired command token closes the socket with 4401
 *  - notifications arrive via Redis channel `ws:user:<id>`; this instance only
 *    subscribes to users that have a socket here
 */

const PING_INTERVAL_MS = 30_000;
const PRESENCE_TTL_S = 75;
/** Slow consumer: close instead of buffering without bound. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;

type Conn = { socket: WebSocket; userId: string; alive: boolean };

const local = new Map<string, Set<Conn>>();
let sub: Redis | null = null;

function subscriber(): Redis {
	if (!sub) {
		sub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
		sub.on("message", (channel: string, message: string) => {
			const userId = channel.slice("ws:user:".length);
			for (const conn of local.get(userId) ?? []) deliver(conn, message);
		});
	}
	return sub;
}

function deliver(conn: Conn, data: string): void {
	const { socket } = conn;
	if (socket.readyState !== socket.OPEN) return;
	if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
		socket.close(1013, "backpressure");
		return;
	}
	socket.send(data);
}

const send = (conn: Conn, value: unknown) => deliver(conn, JSON.stringify(value));

async function attach(conn: Conn): Promise<void> {
	let set = local.get(conn.userId);
	if (!set) {
		set = new Set();
		local.set(conn.userId, set);
		await subscriber().subscribe(userChannel(conn.userId));
	}
	set.add(conn);
	await redis.set(presenceKey(conn.userId), "1", "EX", PRESENCE_TTL_S);
}

async function detach(conn: Conn): Promise<void> {
	const set = local.get(conn.userId);
	if (!set) return;
	set.delete(conn);
	if (set.size === 0) {
		local.delete(conn.userId);
		await subscriber().unsubscribe(userChannel(conn.userId)).catch(() => undefined);
		await redis.del(presenceKey(conn.userId)).catch(() => undefined);
	}
}

/** The command token must be a valid, current session of the socket's user. */
async function commandTokenValid(token: unknown, userId: string): Promise<boolean> {
	if (typeof token !== "string" || !token) return false;
	const claims = await verifySessionJwt(token);
	if (!claims || claims.profileId !== userId) return false;
	if ((await getTokenVersion(claims.profileId)) !== claims.tv) return false;
	// Like the REST gate: banned or awaiting required e-mail verification → no commands.
	return claims.restriction !== "TIMED_BAN" && !claims.featureFlags?.includes("email_verification_required");
}

async function handleFrame(conn: Conn, raw: string): Promise<void> {
	let cmd: { type?: unknown; ref?: unknown; token?: unknown; payload?: unknown } | null = null;
	try {
		cmd = JSON.parse(raw);
	} catch {
		cmd = null;
	}
	if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string" || cmd.ref == null) {
		send(conn, { type: "ws.error", message: "Could not convert frame to command" });
		return;
	}
	const type = cmd.type;
	const ref = String(cmd.ref);
	if (!(await commandTokenValid(cmd.token, conn.userId))) {
		conn.socket.close(4401, "Unauthorized");
		return;
	}
	const respond = (status: number, payload: unknown) => send(conn, { type: `${type}.response`, status, ref, payload });
	try {
		switch (type) {
			case "chat.v1.message.send": {
				const parsed = sendSchema.safeParse(cmd.payload);
				if (!parsed.success) return respond(400, { type: "urn:gr:err:bad_request", title: "Invalid request", status: 400 });
				return respond(201, await sendMessage(BigInt(conn.userId), parsed.data, { allowReply: true }));
			}
			default:
				send(conn, { type: "ws.error", message: "Could not convert frame to command" });
		}
	} catch (e) {
		if (e instanceof ApiError) return respond(e.status, e.body);
		respond(500, { type: "urn:gr:err:internal_error", title: "internal error", status: 500 });
	}
}

export async function realtimeGateway(app: FastifyInstance): Promise<void> {
	await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false } });

	const heartbeat = setInterval(() => {
		const pipeline = redis.pipeline();
		for (const [userId, set] of local) {
			pipeline.set(presenceKey(userId), "1", "EX", PRESENCE_TTL_S);
			for (const conn of set) {
				if (!conn.alive) {
					conn.socket.terminate();
					continue;
				}
				conn.alive = false;
				conn.socket.ping();
			}
		}
		void pipeline.exec().catch(() => undefined);
	}, PING_INTERVAL_MS);
	heartbeat.unref();

	// preClose: open sockets would keep server.close() waiting. Close politely
	// (clients reconnect to another instance), then cut whatever is left.
	app.addHook("preClose", async () => {
		clearInterval(heartbeat);
		const conns = [...local.values()].flatMap((set) => [...set]);
		await Promise.all(
			conns.map(
				(conn) =>
					new Promise<void>((resolve) => {
						if (conn.socket.readyState === conn.socket.CLOSED) return resolve();
						const timer = setTimeout(() => {
							conn.socket.terminate();
							resolve();
						}, 2000);
						conn.socket.once("close", () => {
							clearTimeout(timer);
							resolve();
						});
						conn.socket.close(1001, "server shutdown");
					}),
			),
		);
		local.clear();
		if (sub) {
			sub.disconnect();
			sub = null;
		}
	});

	app.get("/v1/ws", { websocket: true, preHandler: app.authenticate }, (socket: WebSocket, req: FastifyRequest) => {
		const conn: Conn = { socket, userId: req.auth.profileId, alive: true };
		// Frames that arrive before the subscription is ready are queued in order.
		let chain: Promise<void> = attach(conn).then(() => send(conn, { type: "ws.connection.established", timestamp: Date.now() }));
		socket.on("pong", () => {
			conn.alive = true;
		});
		socket.on("message", (data, isBinary) => {
			conn.alive = true;
			const text = isBinary ? "" : data.toString();
			chain = chain.then(() => handleFrame(conn, text)).catch(() => undefined);
		});
		socket.on("close", () => {
			void chain.finally(() => detach(conn)).catch(() => undefined);
		});
		socket.on("error", () => socket.terminate());
	});
}

/** Test/ops helper: sockets connected to this instance. */
export function localConnectionCount(): number {
	let n = 0;
	for (const set of local.values()) n += set.size;
	return n;
}

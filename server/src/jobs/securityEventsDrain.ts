import { redis } from "../cache/redis";
import { db } from "../db/client";
import { securityEvents } from "../db/schema";

/**
 * Moves security events from the Redis stream (written cheaply on the hot
 * path, see lib/securityEvents.ts) into Postgres. A consumer group makes it
 * safe to run in several workers: each entry is delivered to one consumer and
 * only acknowledged after the insert committed.
 */
const STREAM = "stream:security_events";
const GROUP = "drain";

async function ensureGroup(): Promise<void> {
	try {
		await redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
	} catch (e) {
		if (!String((e as Error).message).includes("BUSYGROUP")) throw e;
	}
}

type Entry = [id: string, fields: string[]];

function toRow(fields: string[]) {
	const f: Record<string, string> = {};
	for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
	let detail: unknown = null;
	try {
		detail = f.detail ? JSON.parse(f.detail) : null;
	} catch {
		detail = null;
	}
	return {
		kind: f.kind ?? "unknown",
		userId: f.userId && /^\d+$/.test(f.userId) ? BigInt(f.userId) : null,
		deviceId: f.deviceId || null,
		ip: f.ip || null,
		detail: detail as object | null,
	};
}

/** Drains up to `max` entries; returns how many were stored. */
export async function drainSecurityEvents(consumer: string, max = 5000): Promise<number> {
	await ensureGroup();
	let stored = 0;
	while (stored < max) {
		// Own pending entries first (a crash between insert and ack), then new ones.
		const pending = (await redis.xreadgroup("GROUP", GROUP, consumer, "COUNT", 500, "STREAMS", STREAM, "0")) as [string, Entry[]][] | null;
		let entries = pending?.[0]?.[1] ?? [];
		if (!entries.length) {
			const fresh = (await redis.xreadgroup("GROUP", GROUP, consumer, "COUNT", 500, "STREAMS", STREAM, ">")) as [string, Entry[]][] | null;
			entries = fresh?.[0]?.[1] ?? [];
		}
		if (!entries.length) break;
		await db.insert(securityEvents).values(entries.map(([, fields]) => toRow(fields)));
		await redis.xack(STREAM, GROUP, ...entries.map(([id]) => id));
		await redis.xdel(STREAM, ...entries.map(([id]) => id));
		stored += entries.length;
	}
	return stored;
}

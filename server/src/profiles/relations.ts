import { and, eq, inArray, or } from "drizzle-orm";
import { redis } from "../cache/redis";
import { db } from "../db/client";
import { blocks, favorites, hides } from "../db/schema";

/**
 * Per-user relation sets in Redis (block both directions, hides, favorites)
 * so every grid/profile request filters with SISMEMBER/SMEMBERS instead of
 * joins. Rebuilt lazily from Postgres; invalidated on change.
 */
const K = {
	blockedAny: (id: string) => `rel:blk:${id}`, // users I blocked + users who blocked me
	hidden: (id: string) => `rel:hid:${id}`,
	favs: (id: string) => `rel:fav:${id}`,
	loaded: (id: string) => `rel:ok:${id}`,
};
const TTL = 3600;

async function ensureLoaded(userId: string): Promise<void> {
	if (await redis.exists(K.loaded(userId))) return;
	const uid = BigInt(userId);
	const [blk, hid, fav] = await Promise.all([
		db.select({ a: blocks.ownerId, b: blocks.targetId }).from(blocks).where(or(eq(blocks.ownerId, uid), eq(blocks.targetId, uid))),
		db.select({ t: hides.targetId }).from(hides).where(eq(hides.ownerId, uid)),
		db.select({ t: favorites.targetId }).from(favorites).where(eq(favorites.ownerId, uid)),
	]);
	const p = redis.multi();
	p.del(K.blockedAny(userId), K.hidden(userId), K.favs(userId));
	const blockedIds = blk.map((r) => String(r.a === uid ? r.b : r.a));
	if (blockedIds.length) p.sadd(K.blockedAny(userId), ...blockedIds);
	if (hid.length) p.sadd(K.hidden(userId), ...hid.map((r) => String(r.t)));
	if (fav.length) p.sadd(K.favs(userId), ...fav.map((r) => String(r.t)));
	for (const k of [K.blockedAny(userId), K.hidden(userId), K.favs(userId)]) p.expire(k, TTL);
	p.set(K.loaded(userId), "1", "EX", TTL - 60);
	await p.exec();
}

export type Relations = { blocked: Set<string>; hidden: Set<string>; favorites: Set<string> };

export async function getRelations(userId: string): Promise<Relations> {
	await ensureLoaded(userId);
	const [b, h, f] = await Promise.all([redis.smembers(K.blockedAny(userId)), redis.smembers(K.hidden(userId)), redis.smembers(K.favs(userId))]);
	return { blocked: new Set(b), hidden: new Set(h), favorites: new Set(f) };
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
	await ensureLoaded(a);
	return (await redis.sismember(K.blockedAny(a), b)) === 1;
}

/** Call after any block/hide/favorite change for both users involved. */
export async function invalidateRelations(...userIds: (string | bigint)[]): Promise<void> {
	if (userIds.length) await redis.del(...userIds.map((id) => K.loaded(String(id))));
}

export async function blockedPairs(userId: bigint, others: bigint[]): Promise<Set<string>> {
	if (!others.length) return new Set();
	const rows = await db
		.select({ a: blocks.ownerId, b: blocks.targetId })
		.from(blocks)
		.where(or(and(eq(blocks.ownerId, userId), inArray(blocks.targetId, others)), and(eq(blocks.targetId, userId), inArray(blocks.ownerId, others))));
	return new Set(rows.map((r) => String(r.a === userId ? r.b : r.a)));
}

import { LRUCache } from "lru-cache";
import { redis, redisSub } from "./redis";

/**
 * In-process, short-TTL caches for configuration-like data (flags,
 * entitlement profiles, catalogs, keys). Invalidated cluster-wide via a
 * Redis pub/sub channel, so admin changes apply on every instance at once.
 */
const INVALIDATION_CHANNEL = "cache:invalidate";
const registry = new Map<string, LRUCache<string, { v: unknown }>>();

export function localCache<V>(namespace: string, opts: { max?: number; ttlMs?: number } = {}) {
	let cache = registry.get(namespace);
	if (!cache) {
		cache = new LRUCache<string, { v: unknown }>({ max: opts.max ?? 10_000, ttl: opts.ttlMs ?? 30_000 });
		registry.set(namespace, cache);
	}
	const c = cache;
	return {
		get: (key: string): V | undefined => c.get(key)?.v as V | undefined,
		set: (key: string, value: V) => void c.set(key, { v: value }),
		/** Loads once per key while concurrent callers wait on the same promise. */
		async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
			const hit = c.get(key);
			if (hit) return hit.v as V;
			const pendingKey = `__pending:${key}`;
			const pending = c.get(pendingKey)?.v as Promise<V> | undefined;
			if (pending) return pending;
			const promise = load().finally(() => c.delete(pendingKey));
			c.set(pendingKey, { v: promise }, { ttl: 10_000 });
			const value = await promise;
			c.set(key, { v: value });
			return value;
		},
		delete: (key: string) => void c.delete(key),
		clear: () => c.clear(),
	};
}

/** Clears `namespace` (optionally one key) on every instance. */
export async function invalidate(namespace: string, key?: string): Promise<void> {
	applyInvalidation(namespace, key);
	await redis.publish(INVALIDATION_CHANNEL, JSON.stringify({ namespace, key }));
}

function applyInvalidation(namespace: string, key?: string): void {
	const cache = registry.get(namespace);
	if (!cache) return;
	if (key == null) cache.clear();
	else cache.delete(key);
}

let listening = false;
export async function startInvalidationListener(): Promise<void> {
	if (listening) return;
	listening = true;
	await redisSub.subscribe(INVALIDATION_CHANNEL);
	redisSub.on("message", (channel, message) => {
		if (channel !== INVALIDATION_CHANNEL) return;
		try {
			const { namespace, key } = JSON.parse(message) as { namespace: string; key?: string };
			applyInvalidation(namespace, key ?? undefined);
		} catch {
			// ignore malformed
		}
	});
}

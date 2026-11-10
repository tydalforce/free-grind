import Redis from "ioredis";
import { config } from "../config";

/** Commands. */
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true, lazyConnect: false });
/**
 * Dedicated subscriber connection (a subscribed connection can't run commands).
 * `enableReadyCheck: false`: the ready check sends INFO, which Redis refuses
 * once SUBSCRIBE has put the connection into subscriber mode ("Connection in
 * subscriber mode"). ioredis re-subscribes on reconnect by itself.
 */
export const redisSub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: false });

export async function closeRedis(): Promise<void> {
	await Promise.allSettled([redis.quit(), redisSub.quit()]);
}

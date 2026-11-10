import { afterAll, beforeAll } from "bun:test";
import { closeRedis, redis } from "../src/cache/redis";
import { closeDb } from "../src/db/client";
import { seedFlags } from "../src/flags/seeds";
import { seedCatalogs } from "../src/catalogs/seeds";
import { closeQueues } from "../src/jobs/queues";

/**
 * Global (preloaded via bunfig.toml): DB/Redis are process-wide singletons,
 * so they are closed once after all test files, not per file.
 */
beforeAll(async () => {
	// Every test signs up from 127.0.0.1; reset per-IP limits so reruns pass.
	const keys = await redis.keys("rl:*");
	if (keys.length) await redis.del(...keys);
	await seedFlags();
	await seedCatalogs();
});

afterAll(async () => {
	await closeQueues();
	await Promise.all([closeDb(), closeRedis()]);
});

import { buildApp } from "./app";
import { startInvalidationListener } from "./cache/local";
import { closeRedis } from "./cache/redis";
import { config } from "./config";
import { closeDb } from "./db/client";
import { seedFlags } from "./flags/seeds";
import { seedCatalogs } from "./catalogs/seeds";
import { closeQueues } from "./jobs/queues";
import { PARTITIONED_TABLES, ensureMonthlyPartitions } from "./db/partitions";

await startInvalidationListener();
await seedFlags();
await seedCatalogs();
// Current + upcoming month partitions exist before the first insert (worker keeps them going).
for (const table of PARTITIONED_TABLES) await ensureMonthlyPartitions(table);
const app = await buildApp();
await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		// Bun's HTTP server never releases connections that were upgraded to
		// WebSockets, so server.close() can wait forever: cap it. (Fastify's
		// forceCloseConnections=true is no option: Bun's closeAllConnections
		// also breaks unrelated outgoing sockets.)
		await Promise.race([app.close(), Bun.sleep(10_000)]);
		await closeQueues();
		await Promise.all([closeDb(), closeRedis()]);
		process.exit(0);
	});
}

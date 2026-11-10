import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { mediaQueue, notifyQueue, pushQueue } from "../jobs/queues";
import { localConnectionCount } from "../realtime/gateway";

/**
 * Prometheus metrics at GET /metrics. Enabled only when METRICS_TOKEN is set;
 * the scraper sends it as a bearer token. Caddy never forwards /metrics, so
 * it is reachable only inside the Docker network.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
	name: "http_request_duration_seconds",
	help: "API request latency by route",
	labelNames: ["method", "route", "status"] as const,
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5],
	registers: [registry],
});

const httpErrors = new Counter({
	name: "http_server_errors_total",
	help: "Responses with status >= 500",
	labelNames: ["route"] as const,
	registers: [registry],
});

new Gauge({
	name: "ws_connections",
	help: "WebSocket connections on this instance",
	registers: [registry],
	collect() {
		this.set(localConnectionCount());
	},
});

new Gauge({
	name: "queue_jobs",
	help: "Background jobs by queue and state",
	labelNames: ["queue", "state"] as const,
	registers: [registry],
	async collect() {
		for (const [name, queue] of [["media", mediaQueue], ["push", pushQueue], ["notify", notifyQueue]] as const) {
			const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
			for (const [state, n] of Object.entries(counts)) this.set({ queue: name, state }, n);
		}
	},
});

function tokenOk(header: string | undefined): boolean {
	const expected = process.env.METRICS_TOKEN;
	if (!expected || !header?.startsWith("Bearer ")) return false;
	const given = Buffer.from(header.slice(7));
	const want = Buffer.from(expected);
	return given.length === want.length && timingSafeEqual(given, want);
}

export const metricsPlugin = fp(async (app: FastifyInstance) => {
	app.addHook("onResponse", async (req, reply) => {
		// The route pattern, not the raw URL: keeps label cardinality bounded.
		const route = req.routeOptions.url ?? "unmatched";
		if (route === "/metrics") return;
		httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
		if (reply.statusCode >= 500) httpErrors.inc({ route });
	});

	app.get("/metrics", { config: { clientHeaders: "none" } }, async (req, reply) => {
		if (!tokenOk(req.headers.authorization)) return reply.code(404).send();
		reply.header("content-type", registry.contentType);
		return registry.metrics();
	});
});

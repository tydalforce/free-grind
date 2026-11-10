import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Serves the built admin SPA (server/admin/dist) under /admin. Unknown paths
 * fall back to index.html (client-side routing). Strict CSP: the SPA loads
 * nothing from other origins.
 */
const DIST = resolve(import.meta.dir, "..", "..", "..", "admin", "dist");

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
};

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function sendFile(reply: FastifyReply, path: string, immutable: boolean) {
	reply
		.header("content-type", TYPES[extname(path)] ?? "application/octet-stream")
		.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
		.header("content-security-policy", CSP)
		.header("x-frame-options", "DENY")
		.header("referrer-policy", "no-referrer");
	return reply.send(Bun.file(path).stream());
}

export async function adminUiRoutes(app: FastifyInstance): Promise<void> {
	const handler = async (req: { params: unknown }, reply: FastifyReply) => {
		if (!existsSync(join(DIST, "index.html"))) {
			return reply.code(503).type("text/plain").send("Admin UI not built. Run `bun run admin:build` in server/.");
		}
		const rel = ((req.params as { "*"?: string })["*"] ?? "").replace(/^\/+/, "");
		const target = normalize(join(DIST, rel));
		// Path traversal guard + only real files; everything else → SPA shell.
		if (rel && target.startsWith(DIST) && existsSync(target) && extname(target)) {
			return sendFile(reply, target, rel.startsWith("assets/"));
		}
		return sendFile(reply, join(DIST, "index.html"), false);
	};
	app.get("/admin", handler);
	app.get("/admin/*", async (req, reply) => {
		if ((req.params as { "*": string })["*"].startsWith("api/")) {
			return reply.code(404).send({ error: "not_found" });
		}
		return handler(req, reply);
	});
}

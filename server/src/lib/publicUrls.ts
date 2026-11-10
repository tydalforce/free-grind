import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config";

/**
 * Base URL for media links in API responses. With PUBLIC_MEDIA_URL set (production:
 * the media domain) it is used as is. Unset / "auto" (local dev), links are built
 * from the host the client used for this request, so 127.0.0.1, localhost and a
 * LAN IP all get links on the origin the app actually allows.
 */
const requestOrigin = new AsyncLocalStorage<string>();
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

export function mediaBase(): string {
	return config.PUBLIC_MEDIA_URL ?? requestOrigin.getStore() ?? config.PUBLIC_API_URL.replace(/\/$/, "");
}

export const requestOriginPlugin = fp(async (app: FastifyInstance) => {
	if (config.PUBLIC_MEDIA_URL) return;
	app.addHook("onRequest", (req, _reply, done) => {
		const host = req.host;
		const proto = req.protocol === "https" ? "https" : "http";
		if (!host || !HOST_RE.test(host)) return done();
		requestOrigin.run(`${proto}://${host}`, done);
	});
});

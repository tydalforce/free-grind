import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config";
import { requestOriginPlugin } from "./lib/publicUrls";
import { metricsPlugin } from "./lib/metrics";
import { ApiError, errors } from "./lib/errors";
import { authRoutes } from "./modules/auth/routes";
import { deviceKeyRoutes } from "./modules/devicekeys/routes";
import { verifySignedUpload } from "./modules/devicekeys/signing";
import { systemRoutes } from "./modules/system/routes";
import { authPlugin } from "./plugins/auth";
import { securityHeadersPlugin } from "./plugins/securityHeaders";
import { adminAuthPlugin } from "./admin/auth";
import { adminEntitlementRoutes } from "./admin/routes/entitlements";
import { adminFlagRoutes } from "./admin/routes/flags";
import { adminSessionRoutes } from "./admin/routes/session";
import { adminSystemRoutes } from "./admin/routes/system";
import { adminCatalogRoutes } from "./admin/routes/catalogs";
import { adminUiRoutes } from "./admin/routes/ui";
import { adminUserRoutes } from "./admin/routes/users";
import { adminReportRoutes } from "./admin/routes/reports";
import { adminBroadcastRoutes, adminIntegrationRoutes } from "./admin/routes/integrations";
import { adminSecurityRoutes } from "./admin/routes/security";
import { adminModerationRoutes } from "./admin/routes/moderation";
import { appealRoutes } from "./moderation/appealRoutes";
import { emailVerificationRoutes } from "./modules/auth/emailVerification";
import { adminMediaRoutes } from "./admin/routes/media";
import { entitlementRoutes } from "./modules/entitlements/routes";
import { browseRoutes } from "./browse/routes";
import { mediaRoutes } from "./media/routes";
import { profileRoutes } from "./profiles/routes";
import { profileExtraRoutes } from "./profiles/extras";
import { catalogRoutes } from "./catalogs/routes";
import { favoriteRoutes } from "./profiles/favorites";
import { accountRoutes } from "./modules/account/routes";
import { chatRoutes } from "./chat/routes";
import { chatMediaRoutes } from "./chat/media";
import { realtimeGateway } from "./realtime/gateway";
import { albumRoutes } from "./albums/routes";
import { interactionRoutes } from "./interactions/routes";
import { rightNowRoutes } from "./rightnow/routes";
import { heatmapRoutes } from "./heatmap/routes";
import { pushRoutes } from "./push/routes";
import { videoCallRoutes } from "./videocall/routes";

export async function buildApp(): Promise<FastifyInstance> {
	const app = Fastify({
		logger: config.isTest ? false : { level: config.isProd ? "info" : "debug", redact: ["req.headers.authorization", "req.headers.cookie"] },
		trustProxy: true,
		bodyLimit: 1024 * 1024,
		// Large IDs (profileId) stay strings in JSON; Fastify must not choke on bigint.
		ajv: { customOptions: { coerceTypes: false } },
	});

	// Raw bodies (media uploads) are handled per route; JSON stays default.
	app.addContentTypeParser(/^(application\/octet-stream|(image|video|audio)\/[\w.+-]+)(;.*)?$/, (_req, payload, done) => done(null, payload));

	// Browser forms (password reset page) — small, plain key/value bodies only.
	app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
		done(null, Object.fromEntries(new URLSearchParams(body as string)));
	});

	app.setReplySerializer((payload) => JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

	app.setErrorHandler((err, req, reply) => {
		if (err instanceof ApiError) {
			for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
			return reply.code(err.status).send(err.body);
		}
		const e = err as { statusCode?: number; code?: string; validation?: unknown };
		if (e.validation || e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || e.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
			return reply.code(400).send(errors.badRequest("Invalid request").body);
		}
		if (e.statusCode === 413) return reply.code(413).send({ code: 413, message: "Payload too large" });
		req.log.error({ err }, "unhandled error");
		return reply.code(500).send({ type: "urn:gr:err:internal_error", title: "internal error", status: 500 });
	});

	// Endpoints the app doesn't use are simply absent (plan: 404).
	app.setNotFoundHandler((_req, reply) => reply.code(404).send(errors.notFound().body));

	app.addHook("onSend", async (_req, reply, payload) => {
		reply.header("x-content-type-options", "nosniff");
		return payload;
	});

	// Admin UI/API and infrastructure routes don't carry the app's identity headers.
	app.addHook("onRoute", (route) => {
		if (route.url.startsWith("/admin")) {
			route.config = { ...(route.config ?? {}), clientHeaders: "none" };
		}
	});

	await app.register(requestOriginPlugin);
	await app.register(metricsPlugin);
	await app.register(securityHeadersPlugin);
	await app.register(authPlugin);
	await app.register(adminAuthPlugin);
	await app.register(systemRoutes);
	await app.register(authRoutes);
	await app.register(appealRoutes);
	await app.register(emailVerificationRoutes);
	await app.register(deviceKeyRoutes);
	await app.register(entitlementRoutes);
	await app.register(mediaRoutes);
	await app.register(profileRoutes);
	await app.register(profileExtraRoutes);
	await app.register(catalogRoutes);
	await app.register(favoriteRoutes);
	await app.register(accountRoutes);
	await app.register(browseRoutes);
	await app.register(chatRoutes);
	await app.register(chatMediaRoutes);
	await app.register(albumRoutes);
	await app.register(interactionRoutes);
	await app.register(rightNowRoutes);
	await app.register(heatmapRoutes);
	await app.register(pushRoutes);
	await app.register(videoCallRoutes);
	await app.register(realtimeGateway);

	await app.register(adminSessionRoutes);
	await app.register(adminEntitlementRoutes);
	await app.register(adminUserRoutes);
	await app.register(adminReportRoutes);
	await app.register(adminIntegrationRoutes);
	await app.register(adminBroadcastRoutes);
	await app.register(adminSecurityRoutes);
	await app.register(adminModerationRoutes);
	await app.register(adminMediaRoutes);
	await app.register(adminFlagRoutes);
	await app.register(adminSystemRoutes);
	await app.register(adminCatalogRoutes);
	await app.register(adminUiRoutes);
	if (config.isTest) {
		// Exercise upload signing before the real media routes exist.
		app.post("/__test/signed-upload", { preHandler: app.authenticate }, async (req) => {
			const body = await streamToBuffer(req.body as NodeJS.ReadableStream);
			return { signed: await verifySignedUpload(req, body, { required: true }) };
		});
	}
	return app;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
	return Buffer.concat(chunks);
}

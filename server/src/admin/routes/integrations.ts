import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/client";
import { devices } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { deleteServerSetting, getServerSetting, setServerSetting } from "../../modules/settings/settings";
import { loadServiceAccount, sendToToken, serviceAccountSchema } from "../../push/fcm";
import { audit } from "../audit";
import { notifyQueue } from "../../jobs/queues";
import { countRecipients } from "../../push/broadcast";
import { bumpTokenVersionForProfile } from "../tokenRefresh";
import { loadLiveKit, testLiveKit } from "../../videocall/livekit";

/**
 * Integrations (plan 6b/10): external services configured in the admin UI.
 * Firebase Cloud Messaging: only the service account (secret, write-only),
 * which lets the server send. The app's client config (project, app id, API
 * key, sender id) is compiled into the app at build time (FG_FCM_*), like the
 * server addresses.
 */

async function fcmState() {
	const sa = await loadServiceAccount();
	return {
		serviceAccount: sa ? { projectId: sa.project_id, clientEmail: sa.client_email } : null,
		active: !!sa,
	};
}

async function liveKitState() {
	const cfg = await loadLiveKit();
	const url = (await getServerSetting<string>("livekit.url")) || null;
	const apiKey = (await getServerSetting<string>("livekit.apiKey")) || null;
	return { url, apiKey, secretSet: !!(await getServerSetting<string>("livekit.apiSecret")), active: !!cfg };
}

export async function adminIntegrationRoutes(app: FastifyInstance): Promise<void> {
	// --- LiveKit (video calls) -------------------------------------------------------

	app.get("/admin/api/integrations/livekit", { preHandler: app.requireAdmin }, async () => liveKitState());

	app.put("/admin/api/integrations/livekit", { preHandler: app.requireOwner }, async (req) => {
		const body = z
			.object({
				url: z.string().regex(/^wss?:\/\/[^\s/]+(\/.*)?$/, "WebSocket-URL wie wss://rtc.example.org").or(z.literal("")).optional(),
				apiKey: z.string().max(200).optional(),
				apiSecret: z.string().max(500).optional(),
			})
			.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid_body", detail: body.error.issues[0]?.message });
		const before = await liveKitState();
		const { url, apiKey, apiSecret } = body.data;
		if (url !== undefined) url ? await setServerSetting("livekit.url", url.replace(/\/$/, ""), { actor: req.admin.username }) : await deleteServerSetting("livekit.url");
		if (apiKey !== undefined) apiKey ? await setServerSetting("livekit.apiKey", apiKey, { actor: req.admin.username }) : await deleteServerSetting("livekit.apiKey");
		if (apiSecret !== undefined) apiSecret ? await setServerSetting("livekit.apiSecret", apiSecret, { secret: true, actor: req.admin.username }) : await deleteServerSetting("livekit.apiSecret");
		const after = await liveKitState();
		// CreateVideoCall lives in the session token: re-issue everyone's when it flips.
		if (before.active !== after.active) await bumpTokenVersionForProfile("default");
		await audit(req.admin, "integration.livekit", "livekit", { url: before.url, apiKey: before.apiKey, secretSet: before.secretSet }, { url: after.url, apiKey: after.apiKey, secretSet: after.secretSet });
		return after;
	});

	app.post("/admin/api/integrations/livekit/test", { preHandler: app.requireAdmin }, async () => {
		const cfg = await loadLiveKit();
		if (!cfg) throw new ApiError(400, { error: "not_configured", detail: "URL, API-Key und Secret eintragen" });
		return testLiveKit(cfg);
	});

	// --- Firebase Cloud Messaging --------------------------------------------------------

	app.get("/admin/api/integrations/fcm", { preHandler: app.requireAdmin }, async () => fcmState());

	app.put("/admin/api/integrations/fcm", { preHandler: app.requireOwner }, async (req) => {
		const body = z
			.object({ serviceAccount: z.string().max(20_000).optional() })
			.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid_body", detail: body.error.issues[0]?.message });
		const before = await fcmState();
		if (body.data.serviceAccount !== undefined) {
			if (body.data.serviceAccount.trim() === "") {
				await deleteServerSetting("push.fcm.serviceAccount");
			} else {
				let parsed: unknown;
				try {
					parsed = JSON.parse(body.data.serviceAccount);
				} catch {
					throw new ApiError(400, { error: "invalid_service_account", detail: "Keine gültige JSON-Datei" });
				}
				const sa = serviceAccountSchema.safeParse(parsed);
				if (!sa.success) throw new ApiError(400, { error: "invalid_service_account", detail: "Kein Firebase-Dienstkonto (project_id, client_email, private_key fehlen)" });
				await setServerSetting("push.fcm.serviceAccount", JSON.stringify(sa.data), { secret: true, actor: req.admin.username });
			}
		}
		const after = await fcmState();
		// Never log the key itself.
		await audit(req.admin, "integration.fcm", "fcm", { serviceAccount: before.serviceAccount }, { serviceAccount: after.serviceAccount });
		return after;
	});

	/** Sends a test push to every registered device of a profile and reports per token. */
	app.post("/admin/api/integrations/fcm/test", { preHandler: app.requireAdmin }, async (req) => {
		const { profileId } = z.object({ profileId: z.string().regex(/^\d{1,19}$/) }).parse(req.body);
		const sa = await loadServiceAccount();
		if (!sa) throw new ApiError(400, { error: "not_configured", detail: "Kein Dienstkonto hinterlegt" });
		const tokens = (
			await db
				.select({ token: devices.fcmToken })
				.from(devices)
				.where(and(eq(devices.userId, BigInt(profileId)), isNotNull(devices.fcmToken), isNull(devices.revokedAt)))
		).filter((t): t is { token: string } => !!t.token);
		if (!tokens.length) throw new ApiError(400, { error: "no_tokens", detail: "Dieses Profil hat kein Gerät für Push registriert" });
		const data = {
			version: "2",
			notificationId: crypto.randomUUID(),
			timestamp: String(Date.now()),
			title: "free-grind",
			translateTitle: "false",
			body: "Test-Benachrichtigung vom Server ✔",
			translateBody: "false",
			action: "grindr://taps-inbox",
			channel: "id_grindr_notifications_channel_individual_v2",
		};
		const results = [];
		for (const { token } of tokens) {
			const r = await sendToToken(sa, token, data);
			results.push({ token: `${token.slice(0, 12)}…`, ok: r.ok, error: r.ok ? null : r.error, removed: !r.ok && r.invalidToken });
			if (!r.ok && r.invalidToken) await db.update(devices).set({ fcmToken: null }).where(eq(devices.fcmToken, token));
		}
		return { results };
	});
}

const broadcastSchema = z.object({
	title: z.string().trim().min(1).max(80),
	body: z.string().trim().min(1).max(400),
	target: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("all") }),
		z.object({ kind: z.literal("role"), role: z.enum(["plus", "xtra", "unlimited", "premium"]) }),
		z.object({ kind: z.literal("users"), userIds: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(1000) }),
	]),
});

/** Admin "Broadcast": push announcement to everyone, a role, or chosen profiles. */
export async function adminBroadcastRoutes(app: FastifyInstance): Promise<void> {
	app.post("/admin/api/broadcast/estimate", { preHandler: app.requireAdmin }, async (req) => {
		const { target } = broadcastSchema.pick({ target: true }).parse(req.body);
		return { recipients: await countRecipients(target) };
	});

	app.post("/admin/api/broadcast", { preHandler: app.requireOwner }, async (req) => {
		const parsed = broadcastSchema.safeParse(req.body);
		if (!parsed.success) throw new ApiError(400, { error: "invalid", detail: parsed.error.issues[0]?.message });
		if (!(await loadServiceAccount())) throw new ApiError(400, { error: "not_configured", detail: "Push (Firebase) ist nicht eingerichtet" });
		const recipients = await countRecipients(parsed.data.target);
		await notifyQueue.add("broadcast", { kind: "broadcast", ...parsed.data });
		await audit(req.admin, "broadcast.push", null, null, { ...parsed.data, recipients });
		return { queued: true, recipients };
	});
}

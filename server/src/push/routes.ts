import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { pushSettings } from "../db/schema";
import { errors } from "../lib/errors";

const SETTING_KEYS = [
	"favoritePushNotification",
	"tapPushNotification",
	"tappedPushNotification",
	"mediaRecipientPushNotification",
	"recommendedPushNotification",
	"unreadChatsPushNotification",
	"viewedProfilePushNotification",
] as const;

const settingsSchema = z.object(Object.fromEntries(SETTING_KEYS.map((k) => [k, z.boolean().nullable().optional()])) as Record<(typeof SETTING_KEYS)[number], z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>);

export async function pushRoutes(app: FastifyInstance): Promise<void> {
	const auth = { preHandler: app.authenticate };

	// Tokens: POST /v3/gcm-push-tokens and DELETE /v3/push-tokens live with the
	// device sessions (modules/auth/routes.ts, devices.fcm_token).

	app.get("/v5/push-settings", auth, async (req) => {
		const [row] = await db.select().from(pushSettings).where(eq(pushSettings.userId, req.auth.userId)).limit(1);
		// Every type is offered on our server: never-set means on. (The app hides a
		// toggle whose value is null — that means "not offered to this account".)
		return Object.fromEntries(SETTING_KEYS.map((k) => [k, row?.[k] ?? true]));
	});

	/** Only the fields present in the body change (upstream). */
	app.put("/v5/push-settings", auth, async (req) => {
		const b = settingsSchema.safeParse(req.body ?? {});
		if (!b.success) throw errors.badRequest("Invalid request");
		const set = Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined));
		await db
			.insert(pushSettings)
			.values({ userId: req.auth.userId, ...set })
			.onConflictDoUpdate({ target: pushSettings.userId, set: { ...set, updatedAt: new Date() } });
		return {};
	});

	/** Delivery acknowledgements: accepted, nothing to do on our side yet. */
	app.post("/public/v1/notifications/ack", { config: { clientHeaders: "none" } }, async () => ({}));
}

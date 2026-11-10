import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config";
import { db } from "../../db/client";
import { admins } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { enforceRateLimit } from "../../lib/rateLimit";
import { decryptSecret, encryptSecret } from "../../lib/secrets";
import { audit } from "../audit";
import { adminPasswordOpts, endAdminSession, newTotpSecret, startAdminSession, verifyTotp } from "../auth";

const DUMMY = await Bun.password.hash("timing-equalizer", adminPasswordOpts);

export async function adminSessionRoutes(app: FastifyInstance): Promise<void> {
	app.post("/admin/api/login", async (req, reply) => {
		await enforceRateLimit(`admin-login:${req.ip}`, 10, 900_000, { ip: req.ip });
		const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256), totp: z.string().max(10).optional() }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid" });
		const [admin] = await db.select().from(admins).where(eq(admins.username, body.data.username)).limit(1);
		const ok = await Bun.password.verify(body.data.password, admin?.passwordHash ?? DUMMY);
		if (!admin || !ok || admin.disabled) throw new ApiError(401, { error: "invalid_credentials" });
		if (admin.totpSecret) {
			const secret = decryptSecret(admin.totpSecret, config.APP_SECRET) as string;
			if (!body.data.totp) throw new ApiError(401, { error: "totp_required" });
			if (!verifyTotp(secret, body.data.totp)) throw new ApiError(401, { error: "invalid_totp" });
		}
		await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));
		await startAdminSession(reply, req, admin.id);
		return { username: admin.username, role: admin.role };
	});

	app.post("/admin/api/logout", { preHandler: app.requireAdmin }, async (req, reply) => {
		await endAdminSession(reply, req.admin.sessionId);
		return { ok: true };
	});

	app.get("/admin/api/me", { preHandler: app.requireAdmin }, async (req) => {
		const [row] = await db.select({ totp: admins.totpSecret }).from(admins).where(eq(admins.id, req.admin.id)).limit(1);
		return { username: req.admin.username, role: req.admin.role, totpEnabled: !!row?.totp };
	});

	/** Step 1: a fresh secret (not stored yet). Step 2: confirm with a code → stored. */
	app.post("/admin/api/me/totp/setup", { preHandler: app.requireAdmin }, async (req) => {
		const secret = newTotpSecret();
		const label = encodeURIComponent(`free-grind-server:${req.admin.username}`);
		return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=free-grind-server` };
	});

	app.post("/admin/api/me/totp/enable", { preHandler: app.requireAdmin }, async (req) => {
		const body = z.object({ secret: z.string().regex(/^[A-Z2-7]{32}$/), code: z.string() }).safeParse(req.body);
		if (!body.success || !verifyTotp(body.data.secret, body.data.code)) throw new ApiError(400, { error: "invalid_totp" });
		await db.update(admins).set({ totpSecret: encryptSecret(body.data.secret, config.APP_SECRET) }).where(eq(admins.id, req.admin.id));
		await audit(req.admin, "admin.totp.enable", `admin:${req.admin.username}`, null, null);
		return { ok: true };
	});

	app.post("/admin/api/me/password", { preHandler: app.requireAdmin }, async (req) => {
		const body = z.object({ current: z.string(), next: z.string().min(12).max(256) }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid" });
		const [admin] = await db.select().from(admins).where(eq(admins.id, req.admin.id)).limit(1);
		if (!admin || !(await Bun.password.verify(body.data.current, admin.passwordHash))) throw new ApiError(400, { error: "invalid_credentials" });
		await db.update(admins).set({ passwordHash: await Bun.password.hash(body.data.next, adminPasswordOpts) }).where(eq(admins.id, admin.id));
		await audit(req.admin, "admin.password.change", `admin:${admin.username}`, null, null);
		return { ok: true };
	});
}

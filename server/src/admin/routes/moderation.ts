import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dbRead } from "../../db/client";
import { APPEAL_STATUSES, banAppeals } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { banNetwork, banDevices, listDeviceBans, listNetworkBans, liftDeviceBan, liftNetworkBan, normalizeCidr } from "../../moderation/accessBans";
import { decideAppeal, listAppeals } from "../../moderation/appeals";
import { audit } from "../audit";

const idParam = z.object({ id: z.string().regex(/^\d{1,19}$/) });
const DEVICE_ID = /^[0-9a-f]{16}$/i;

/** Ban appeals plus device and network bans. */
export async function adminModerationRoutes(app: FastifyInstance): Promise<void> {
	// --- Appeals --------------------------------------------------------------------

	app.get("/admin/api/appeals", { preHandler: app.requireAdmin }, async (req) => {
		const q = z
			.object({
				status: z.enum([...APPEAL_STATUSES, "all"]).default("PENDING"),
				before: z.string().regex(/^\d+$/).optional(),
				limit: z.coerce.number().int().min(1).max(100).default(50),
			})
			.parse(req.query);
		const rows = await listAppeals({ status: q.status, before: q.before ? BigInt(q.before) : undefined, limit: q.limit });
		const [counts] = await dbRead
			.select({
				pending: sql<number>`count(*) FILTER (WHERE ${banAppeals.status} = 'PENDING')::int`,
				granted: sql<number>`count(*) FILTER (WHERE ${banAppeals.status} = 'GRANTED')::int`,
				rejected: sql<number>`count(*) FILTER (WHERE ${banAppeals.status} = 'REJECTED')::int`,
			})
			.from(banAppeals);
		return {
			appeals: rows.map((r) => ({
				...r.appeal,
				id: String(r.appeal.id),
				userId: String(r.appeal.userId),
				banId: r.appeal.banId != null ? String(r.appeal.banId) : null,
				displayName: r.displayName,
				accountEmail: r.email,
				ban: r.ban?.id != null ? { ...r.ban, id: String(r.ban.id) } : null,
			})),
			counts,
			next: rows.length === q.limit ? String(rows[rows.length - 1]!.appeal.id) : null,
		};
	});

	app.post("/admin/api/appeals/:id/decision", { preHandler: app.requireAdmin }, async (req) => {
		const { id } = idParam.parse(req.params);
		const body = z.object({ status: z.enum(["GRANTED", "REJECTED"]), note: z.string().max(2000).nullish() }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		const result = await decideAppeal(BigInt(id), body.data.status, req.admin.username, body.data.note ?? null);
		if (result === "not_found") throw new ApiError(404, { error: "not_found" });
		if (result === "already_decided") throw new ApiError(409, { error: "already_decided" });
		await audit(req.admin, "appeal.decide", `appeal:${id}`, null, body.data);
		return { ok: true };
	});

	// --- Device bans ----------------------------------------------------------------

	app.get("/admin/api/device-bans", { preHandler: app.requireAdmin }, async () => ({
		bans: (await listDeviceBans()).map((b) => ({ ...b, id: String(b.id), userId: b.userId != null ? String(b.userId) : null })),
	}));

	app.post("/admin/api/device-bans", { preHandler: app.requireAdmin }, async (req) => {
		const body = z.object({ deviceId: z.string().trim().regex(DEVICE_ID), note: z.string().max(2000).nullish() }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: "Geräte-ID: 16 Hex-Zeichen (erstes Feld von L-Device-Info)" });
		const result = await banDevices([body.data.deviceId], { note: body.data.note ?? null, createdBy: req.admin.username });
		await audit(req.admin, "device.ban", `device:${body.data.deviceId.toLowerCase()}`, null, { note: body.data.note ?? null, accountsBanned: result.accounts });
		return { added: result.devices, accountsBanned: result.accounts };
	});

	app.delete("/admin/api/device-bans/:id", { preHandler: app.requireAdmin }, async (req) => {
		const { id } = idParam.parse(req.params);
		const lifted = await liftDeviceBan(BigInt(id), req.admin.username);
		await audit(req.admin, "device.unban", `device-ban:${id}`, null, { lifted });
		return { lifted };
	});

	// --- Network bans ---------------------------------------------------------------

	app.get("/admin/api/network-bans", { preHandler: app.requireAdmin }, async () => ({
		bans: (await listNetworkBans()).map((b) => ({ ...b, id: String(b.id) })),
	}));

	app.post("/admin/api/network-bans", { preHandler: app.requireAdmin }, async (req) => {
		const body = z
			.object({ cidr: z.string().max(64), durationHours: z.number().positive().max(24 * 3650).nullish(), note: z.string().max(2000).nullish() })
			.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		const cidr = await normalizeCidr(body.data.cidr);
		if (!cidr) throw new ApiError(400, { error: "invalid", detail: "Ungültiges Netz, z. B. 203.0.113.0/24, 2001:db8::/32 oder eine einzelne Adresse" });
		const expiresAt = body.data.durationHours ? new Date(Date.now() + body.data.durationHours * 3_600_000) : null;
		const row = await banNetwork(cidr, { expiresAt, note: body.data.note ?? null, createdBy: req.admin.username });
		await audit(req.admin, "network.ban", `network:${cidr}`, null, { expiresAt, note: body.data.note ?? null });
		return { ban: { ...row, id: String(row.id) } };
	});

	app.delete("/admin/api/network-bans/:id", { preHandler: app.requireAdmin }, async (req) => {
		const { id } = idParam.parse(req.params);
		const lifted = await liftNetworkBan(BigInt(id), req.admin.username);
		await audit(req.admin, "network.unban", `network-ban:${id}`, null, { lifted });
		return { lifted };
	});
}

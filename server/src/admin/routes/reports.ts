import { and, desc, eq, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, dbRead } from "../../db/client";
import { profiles, reports } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { audit } from "../audit";

export const REPORT_STATUSES = ["PENDING", "RESOLVED", "DISMISSED"] as const;

/** Profile reports (/v3.1|v5/flags) for moderators: list, details, resolve/dismiss. */
export async function adminReportRoutes(app: FastifyInstance): Promise<void> {
	const reporter = alias(profiles, "reporter_profile");
	const reported = alias(profiles, "reported_profile");

	app.get("/admin/api/reports", { preHandler: app.requireAdmin }, async (req) => {
		const q = z
			.object({
				status: z.enum([...REPORT_STATUSES, "all"]).default("PENDING"),
				profileId: z.string().regex(/^\d{1,19}$/).optional(),
				before: z.string().regex(/^\d+$/).optional(),
				limit: z.coerce.number().int().min(1).max(100).default(50),
			})
			.parse(req.query);
		const conds = [];
		if (q.status !== "all") conds.push(eq(reports.status, q.status));
		if (q.profileId) conds.push(eq(reports.profileId, BigInt(q.profileId)));
		if (q.before) conds.push(lt(reports.id, Number(q.before)));
		const rows = await dbRead
			.select({
				id: reports.id,
				reporterId: reports.reporterId,
				reporterName: reporter.displayName,
				profileId: reports.profileId,
				profileName: reported.displayName,
				reason: reports.reason,
				comment: reports.comment,
				locations: reports.locations,
				context: reports.context,
				status: reports.status,
				createdAt: reports.createdAt,
				// How often this profile has been reported overall (still open).
				openForProfile: sql<number>`(SELECT count(*)::int FROM reports r2 WHERE r2.profile_id = ${reports.profileId} AND r2.status = 'PENDING')`,
			})
			.from(reports)
			.leftJoin(reporter, eq(reporter.userId, reports.reporterId))
			.leftJoin(reported, eq(reported.userId, reports.profileId))
			.where(conds.length ? and(...conds) : undefined)
			.orderBy(desc(reports.id))
			.limit(q.limit);
		const [counts] = await dbRead
			.select({
				pending: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'PENDING')::int`,
				resolved: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'RESOLVED')::int`,
				dismissed: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'DISMISSED')::int`,
			})
			.from(reports);
		return {
			reports: rows.map((r) => ({ ...r, id: String(r.id), reporterId: String(r.reporterId), profileId: String(r.profileId) })),
			counts,
			next: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null,
		};
	});

	app.patch("/admin/api/reports/:id", { preHandler: app.requireAdmin }, async (req) => {
		const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
		const { status } = z.object({ status: z.enum(REPORT_STATUSES) }).parse(req.body);
		const [before] = await db.select({ status: reports.status, profileId: reports.profileId }).from(reports).where(eq(reports.id, Number(id))).limit(1);
		if (!before) throw new ApiError(404, { error: "not_found" });
		await db.update(reports).set({ status }).where(eq(reports.id, Number(id)));
		await audit(req.admin, "report.status", `report:${id}`, { status: before.status }, { status, profileId: String(before.profileId) });
		return { ok: true };
	});

	/** Closes every open report about a profile at once (e.g. after a ban). */
	app.post("/admin/api/reports/profile/:profileId/close", { preHandler: app.requireAdmin }, async (req) => {
		const { profileId } = z.object({ profileId: z.string().regex(/^\d{1,19}$/) }).parse(req.params);
		const { status } = z.object({ status: z.enum(["RESOLVED", "DISMISSED"]) }).parse(req.body);
		const updated = await db
			.update(reports)
			.set({ status })
			.where(and(eq(reports.profileId, BigInt(profileId)), eq(reports.status, "PENDING")))
			.returning({ id: reports.id });
		await audit(req.admin, "report.close_all", `user:${profileId}`, null, { status, count: updated.length });
		return { closed: updated.length };
	});
}

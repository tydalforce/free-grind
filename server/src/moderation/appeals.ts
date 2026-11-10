import { and, desc, eq, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, dbRead } from "../db/client";
import { APPEAL_STATUSES, banAppeals, bans, profiles, users } from "../db/schema";
import { currentBan, liftBan, type BanState } from "./bans";

export type AppealRow = typeof banAppeals.$inferSelect;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export type AppealInput = {
	source: "app" | "web";
	userEmail?: string | null;
	userDevice?: string | null;
	userLocation?: string | null;
	countryCode?: string | null;
	userVpn?: boolean | null;
	description?: string | null;
};

/** The appeal for the ban currently in effect, if the user filed one. */
export async function appealForBan(userId: bigint, state: NonNullable<BanState>): Promise<AppealRow | null> {
	const [row] = await db
		.select()
		.from(banAppeals)
		.where(and(eq(banAppeals.userId, userId), eq(banAppeals.banId, state.ban.id)))
		.orderBy(desc(banAppeals.id))
		.limit(1);
	return row ?? null;
}

export type SubmitResult = { kind: "not_banned" } | { kind: "exists"; appeal: AppealRow } | { kind: "created"; appeal: AppealRow };

/** One appeal per ban: a second submission returns the first one unchanged. */
export async function submitAppeal(userId: bigint, input: AppealInput): Promise<SubmitResult> {
	const state = await currentBan(userId);
	if (!state) return { kind: "not_banned" };
	const existing = await appealForBan(userId, state);
	if (existing) return { kind: "exists", appeal: existing };
	const [appeal] = await db
		.insert(banAppeals)
		.values({
			userId,
			banId: state.ban.id,
			source: input.source,
			userEmail: input.userEmail ?? null,
			userDevice: input.userDevice ?? null,
			userLocation: input.userLocation ?? null,
			countryCode: input.countryCode ?? null,
			userVpn: input.userVpn ?? null,
			description: input.description ?? null,
		})
		.returning();
	return { kind: "created", appeal: appeal! };
}

export type DecideResult = "decided" | "not_found" | "already_decided";

/** GRANTED lifts the ban the appeal was filed against (if it's still the open one). */
export async function decideAppeal(id: bigint, status: Exclude<AppealStatus, "PENDING">, by: string, note: string | null): Promise<DecideResult> {
	const [appeal] = await db.select().from(banAppeals).where(eq(banAppeals.id, id)).limit(1);
	if (!appeal) return "not_found";
	if (appeal.status !== "PENDING") return "already_decided";
	await db.update(banAppeals).set({ status, decisionNote: note, decidedBy: by, decidedAt: new Date() }).where(eq(banAppeals.id, id));
	if (status === "GRANTED") {
		const state = await currentBan(appeal.userId);
		if (state && state.ban.id === appeal.banId) await liftBan(appeal.userId, `appeal:${by}`);
	}
	return "decided";
}

export async function listAppeals(q: { status: AppealStatus | "all"; before?: bigint; limit: number }) {
	const banned = alias(bans, "appeal_ban");
	const conds = [];
	if (q.status !== "all") conds.push(eq(banAppeals.status, q.status));
	if (q.before) conds.push(lt(banAppeals.id, q.before));
	return dbRead
		.select({
			appeal: banAppeals,
			displayName: profiles.displayName,
			email: users.email,
			ban: {
				id: banned.id,
				type: banned.type,
				reason: banned.reason,
				subReason: banned.subReason,
				expiresAt: banned.expiresAt,
				createdAt: banned.createdAt,
				liftedAt: banned.liftedAt,
				note: banned.note,
			},
		})
		.from(banAppeals)
		.leftJoin(profiles, eq(profiles.userId, banAppeals.userId))
		.leftJoin(users, eq(users.id, banAppeals.userId))
		.leftJoin(banned, eq(banned.id, banAppeals.banId))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(banAppeals.id))
		.limit(q.limit);
}

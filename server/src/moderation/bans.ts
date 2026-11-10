import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { bans, users } from "../db/schema";
import type { SessionClaims } from "../lib/jwt";
import { ApiError, coded } from "../lib/errors";
import { bumpTokenVersion } from "../modules/auth/sessions";
import { invalidateProfileCard } from "../profiles/cards";

export type BanRow = typeof bans.$inferSelect;

/**
 * Lifecycle of a ban (upstream semantics, docs authentication.md + legal-agreements.md):
 *  - "permanent":          sign-in/refresh refused with code 27 (35 for underage)
 *  - "active":             timed ban running → session carries restriction TIMED_BAN
 *  - "agreementPending":   timed ban over, ban agreement not yet accepted → still TIMED_BAN,
 *                          banDetails.isAgreementCompleted = false; POST /v1/agreements/ban lifts it
 *  - null:                 no ban in effect
 */
export type BanState =
	| { kind: "permanent"; ban: BanRow }
	| { kind: "active"; ban: BanRow }
	| { kind: "agreementPending"; ban: BanRow }
	| null;

const UNDERAGE_REASONS = new Set(["Underage User", "Underage - 12 and under"]);
const UNDERAGE_SUB_REASONS = new Set(["UNDERAGE_ACCESS", "UNDERAGE_IMPERSONATION"]);

export function stateOf(ban: BanRow | undefined, now = Date.now()): BanState {
	if (!ban || ban.liftedAt) return null;
	if (ban.type === "permanent") return { kind: "permanent", ban };
	if (ban.expiresAt && ban.expiresAt.getTime() > now) return { kind: "active", ban };
	if (ban.requireAgreement && !ban.agreementCompletedAt) return { kind: "agreementPending", ban };
	return null;
}

export async function currentBan(userId: bigint): Promise<BanState> {
	const [row] = await db
		.select()
		.from(bans)
		.where(and(eq(bans.userId, userId), isNull(bans.liftedAt)))
		.orderBy(desc(bans.createdAt))
		.limit(1);
	return stateOf(row);
}

/** JWT restriction claims for the state (TIMED_BAN while active or awaiting the agreement). */
export function banClaims(state: BanState): Pick<SessionClaims, "restriction" | "restrictionReason" | "banDetails"> {
	if (!state || state.kind === "permanent") return { restriction: null, restrictionReason: null };
	const b = state.ban;
	return {
		restriction: "TIMED_BAN",
		restrictionReason: null,
		banDetails: {
			// Unix ms (the client also accepts seconds; see AccountStatusPrompt expiryMs).
			expiryTime: b.expiresAt ? b.expiresAt.getTime() : null,
			reason: b.reason,
			subReason: b.subReason,
			isAutomated: b.automated,
			isAgreementCompleted: state.kind === "agreementPending" ? false : !b.requireAgreement,
		},
	};
}

/**
 * Session lifetime cap: a token minted during an active timed ban expires
 * when the ban does, so the client refreshes right then and gets either the
 * agreement prompt or an unrestricted session.
 */
export function sessionExpiryCapMs(state: BanState): number | null {
	return state?.kind === "active" && state.ban.expiresAt ? state.ban.expiresAt.getTime() : null;
}

/** Upstream sign-in/refresh refusal for a permanent ban (BanKind::Profile / ::Underage in the client). */
export function permanentBanError(state: Extract<BanState, { kind: "permanent" }>, profileId: string): ApiError {
	const b = state.ban;
	const underage = (b.reason && UNDERAGE_REASONS.has(b.reason)) || (b.subReason && UNDERAGE_SUB_REASONS.has(b.subReason));
	return coded(403, underage ? 35 : 27, underage ? "Profile is banned (underage)" : "Profile is banned", {
		profileId,
		type: null,
		reason: b.reason,
		isBanAutomated: b.automated,
		thirdPartyUserIdToShow: null,
		banSubReason: b.subReason,
	});
}

/** Keeps users.banned_until (grid/search visibility) in sync with the ban state. */
async function syncBannedUntil(userId: bigint): Promise<void> {
	const state = await currentBan(userId);
	const until =
		state === null
			? null
			: state.kind === "active" && !state.ban.requireAgreement
				? state.ban.expiresAt
				: sql`'infinity'::timestamptz`;
	await db.update(users).set({ bannedUntil: until as Date | null }).where(eq(users.id, userId));
	await invalidateProfileCard(userId);
}

export type BanInput = {
	type: "timed" | "permanent";
	reason: string | null;
	subReason: string | null;
	automated?: boolean;
	requireAgreement: boolean;
	expiresAt: Date | null;
	note?: string | null;
	createdBy: string;
};

export async function banUser(userId: bigint, input: BanInput): Promise<BanRow> {
	if (input.type === "timed" && (!input.expiresAt || input.expiresAt.getTime() <= Date.now())) {
		throw new ApiError(400, { error: "invalid_expiry", detail: "timed bans need an end in the future" });
	}
	const row = await db.transaction(async (tx) => {
		// A new ban supersedes any open one.
		await tx.update(bans).set({ liftedAt: new Date(), liftedBy: `superseded:${input.createdBy}` }).where(and(eq(bans.userId, userId), isNull(bans.liftedAt)));
		const [created] = await tx
			.insert(bans)
			.values({
				userId,
				type: input.type,
				reason: input.reason,
				subReason: input.subReason,
				automated: input.automated ?? false,
				requireAgreement: input.type === "timed" ? input.requireAgreement : false,
				expiresAt: input.type === "timed" ? input.expiresAt : null,
				note: input.note ?? null,
				createdBy: input.createdBy,
			})
			.returning();
		return created!;
	});
	await syncBannedUntil(userId);
	// Running sessions get 401 → refresh → restriction (timed) or code 27 (permanent).
	await bumpTokenVersion(userId);
	return row;
}

export async function liftBan(userId: bigint, by: string): Promise<boolean> {
	const lifted = await db
		.update(bans)
		.set({ liftedAt: new Date(), liftedBy: by })
		.where(and(eq(bans.userId, userId), isNull(bans.liftedAt)))
		.returning({ id: bans.id });
	await syncBannedUntil(userId);
	await bumpTokenVersion(userId);
	return lifted.length > 0;
}

export type AgreementResult = "accepted" | "nothing_to_accept" | "ban_still_active";

/** POST /v1/agreements/ban: only once a timed ban has run out (the client offers it then). */
export async function acceptBanAgreement(userId: bigint): Promise<AgreementResult> {
	const state = await currentBan(userId);
	if (!state) return "nothing_to_accept";
	if (state.kind !== "agreementPending") return state.kind === "active" ? "ban_still_active" : "nothing_to_accept";
	await db.update(bans).set({ agreementCompletedAt: new Date() }).where(eq(bans.id, state.ban.id));
	await syncBannedUntil(userId);
	await bumpTokenVersion(userId);
	return "accepted";
}

export async function banHistory(userId: bigint): Promise<BanRow[]> {
	return db.select().from(bans).where(eq(bans.userId, userId)).orderBy(desc(bans.createdAt)).limit(50);
}

/**
 * Worker job: timed bans without agreement that just ended → visible again.
 * (Restriction claims already drop on the next refresh; this only fixes the
 * denormalized grid visibility and cached cards.)
 */
export async function sweepExpiredBans(): Promise<number> {
	const rows = await db
		.select({ userId: users.id })
		.from(users)
		.where(sql`${users.bannedUntil} IS NOT NULL AND ${users.bannedUntil} <> 'infinity'::timestamptz AND ${users.bannedUntil} <= now()`)
		.limit(1000);
	for (const r of rows) await syncBannedUntil(r.userId);
	return rows.length;
}

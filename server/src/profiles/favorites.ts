import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { favorites, users } from "../db/schema";
import { checkCap } from "../entitlements/enforce";
import { errors } from "../lib/errors";
import { invalidateRelations, isBlockedEitherWay } from "./relations";

/**
 * Favorites and their notes. A note (text + phone number) belongs to a
 * favorite: no favorite, no note — and removing the favorite removes it too.
 */

const idParam = z.string().regex(/^\d{1,19}$/);
const noteBody = z.object({
	notes: z.string().max(2000).optional().default(""),
	phoneNumber: z.string().max(40).optional().default(""),
});

async function targetExists(id: bigint): Promise<boolean> {
	const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), sql`${users.deletedAt} IS NULL`)).limit(1);
	return !!row;
}

const isFav = (owner: bigint, target: bigint) => and(eq(favorites.ownerId, owner), eq(favorites.targetId, target));

/** Stores the note on an existing favorite; false when there is no such favorite. */
async function setNote(owner: bigint, target: bigint, notes: string, phoneNumber: string): Promise<boolean> {
	const empty = !notes.trim() && !phoneNumber.trim();
	const updated = await db
		.update(favorites)
		.set({ notes: empty ? null : notes, phoneNumber: empty ? null : phoneNumber })
		.where(isFav(owner, target))
		.returning({ t: favorites.targetId });
	return updated.length > 0;
}

export async function favoriteRoutes(app: FastifyInstance): Promise<void> {
	app.post("/v3/me/favorites/:profileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { profileId: string }).profileId));
		if (target === req.auth.userId) throw errors.clientAction("can't favorite yourself");
		if (!(await targetExists(target))) throw errors.notFound();
		if (await isBlockedEitherWay(req.auth.profileId, String(target))) throw errors.forbidden();
		const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(favorites).where(eq(favorites.ownerId, req.auth.userId));
		await checkCap(req.auth.userId, "favorites.max", count?.n ?? 0);
		await db.insert(favorites).values({ ownerId: req.auth.userId, targetId: target }).onConflictDoNothing();
		await invalidateRelations(req.auth.userId);
		return {};
	});

	/** Unfavoriting deletes the row — and with it the note. */
	app.delete("/v3/me/favorites/:profileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { profileId: string }).profileId));
		await db.delete(favorites).where(isFav(req.auth.userId, target));
		await invalidateRelations(req.auth.userId);
		return {};
	});

	/** Notes of all favorites that have one. */
	app.get("/v1/favorites/notes", { preHandler: app.authenticate }, async (req) => {
		const rows = await db
			.select({ targetId: favorites.targetId, notes: favorites.notes, phoneNumber: favorites.phoneNumber })
			.from(favorites)
			.where(and(eq(favorites.ownerId, req.auth.userId), sql`(${favorites.notes} IS NOT NULL OR ${favorites.phoneNumber} IS NOT NULL)`))
			.orderBy(desc(favorites.createdAt))
			.limit(5000);
		return rows.map((r) => ({ counterpartyId: String(r.targetId), notes: r.notes ?? "", phoneNumber: r.phoneNumber ?? "" }));
	});

	/** No favorite / no note → empty strings, so the client's note sheet just opens empty. */
	app.get("/v1/favorites/notes/:targetProfileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { targetProfileId: string }).targetProfileId));
		const [row] = await db.select({ notes: favorites.notes, phoneNumber: favorites.phoneNumber }).from(favorites).where(isFav(req.auth.userId, target)).limit(1);
		return { notes: row?.notes ?? "", phoneNumber: row?.phoneNumber ?? "" };
	});

	app.put("/v1/favorites/notes/:targetProfileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { targetProfileId: string }).targetProfileId));
		const body = noteBody.safeParse(req.body ?? {});
		if (!body.success) throw errors.parameter(body.error.issues[0]?.path.join("."));
		// Only favorites can carry a note.
		if (!(await setNote(req.auth.userId, target, body.data.notes, body.data.phoneNumber))) throw errors.notFound();
		return {};
	});

	/** Bulk variant: [{ counterpartyId, notes, phoneNumber }]; entries for non-favorites are skipped. */
	app.put("/v1/favorites/notes", { preHandler: app.authenticate }, async (req) => {
		const body = z
			.array(z.object({ counterpartyId: z.union([z.string().regex(/^\d+$/), z.number().int()]), notes: z.string().max(2000).default(""), phoneNumber: z.string().max(40).default("") }))
			.max(500)
			.safeParse(req.body);
		if (!body.success) throw errors.badRequest();
		for (const n of body.data) await setNote(req.auth.userId, BigInt(n.counterpartyId), n.notes, n.phoneNumber);
		return {};
	});

	app.delete("/v1/favorites/notes/:targetProfileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { targetProfileId: string }).targetProfileId));
		await setNote(req.auth.userId, target, "", "");
		return {};
	});
}

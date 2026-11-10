import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidate } from "../../cache/local";
import { db } from "../../db/client";
import { CATALOG_TYPES, catalogItems, catalogTranslations } from "../../db/schema";
import { catalogLocales, loadCatalog } from "../../catalogs/service";
import { ApiError } from "../../lib/errors";
import { audit } from "../audit";

/**
 * "Inhalte & Sprachen": genders, pronouns, tag categories and tags with their
 * translations. Items are never deleted (profiles reference their ids) — only
 * deactivated, which removes them from the app's choices.
 */

const typeParam = z.enum(CATALOG_TYPES);
const localeSchema = z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/);
const tagKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const metaSchema = z
	.object({
		displayGroup: z.number().int().min(0).max(100).optional(),
		sortFilter: z.number().int().nullable().optional(),
		sortProfile: z.number().int().nullable().optional(),
		excludeOnProfileSelection: z.array(z.number().int()).max(50).nullable().optional(),
		excludeOnFilterSelection: z.array(z.number().int()).max(50).nullable().optional(),
	})
	.strict();
const translationSchema = z.object({
	label: z.string().trim().min(1).max(120),
	extra: z.object({ plural: z.string().max(120).optional(), possessiveText: z.string().max(120).optional() }).strict().optional().default({}),
});

async function changed(): Promise<void> {
	await invalidate("catalogs");
}

function serializeAll(items: Awaited<ReturnType<typeof loadCatalog>>) {
	const locales = catalogLocales(items);
	const coverage = Object.fromEntries(
		locales.map((l) => {
			const total = items.filter((i) => i.active).length || 1;
			const done = items.filter((i) => i.active && i.translations.has(l)).length;
			return [l, Math.round((done / total) * 100)];
		}),
	);
	return {
		types: CATALOG_TYPES,
		locales,
		coverage,
		items: items.map((i) => ({ ...i, translations: Object.fromEntries(i.translations) })),
	};
}

export async function adminCatalogRoutes(app: FastifyInstance): Promise<void> {
	app.get("/admin/api/catalogs", { preHandler: app.requireAdmin }, async () => serializeAll(await loadCatalog()));

	app.post("/admin/api/catalogs/:type", { preHandler: app.requireOwner }, async (req) => {
		const type = typeParam.parse((req.params as { type: string }).type);
		const body = z
			.object({ key: tagKey.optional(), parentId: z.number().int().optional(), meta: metaSchema.optional(), translations: z.record(localeSchema, translationSchema) })
			.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		const b = body.data;
		if (type === "tag" && (!b.key || b.parentId == null)) throw new ApiError(400, { error: "tag_needs_key_and_category" });
		if (!Object.keys(b.translations).length) throw new ApiError(400, { error: "needs_a_translation" });
		const created = await db.transaction(async (tx) => {
			const [{ next }] = (await tx.select({ next: sql<number>`coalesce(max(${catalogItems.itemId}), 0) + 1` }).from(catalogItems).where(eq(catalogItems.type, type))) as [{ next: number }];
			const [{ sort }] = (await tx.select({ sort: sql<number>`coalesce(max(${catalogItems.sort}), -1) + 1` }).from(catalogItems).where(eq(catalogItems.type, type))) as [{ sort: number }];
			await tx.insert(catalogItems).values({ type, itemId: next, key: b.key ?? null, parentId: b.parentId ?? null, sort, meta: b.meta ?? {} });
			await tx.insert(catalogTranslations).values(Object.entries(b.translations).map(([locale, t]) => ({ type, itemId: next, locale, label: t.label, extra: t.extra })));
			return next;
		});
		await changed();
		await audit(req.admin, "catalog.create", `${type}:${created}`, null, b);
		return { itemId: created };
	});

	app.put("/admin/api/catalogs/:type/:itemId", { preHandler: app.requireOwner }, async (req) => {
		const type = typeParam.parse((req.params as { type: string }).type);
		const itemId = z.coerce.number().int().parse((req.params as { itemId: string }).itemId);
		const body = z.object({ sort: z.number().int().optional(), active: z.boolean().optional(), parentId: z.number().int().optional(), meta: metaSchema.optional() }).strict().safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		const updated = await db
			.update(catalogItems)
			.set({ ...body.data, updatedAt: new Date() })
			.where(and(eq(catalogItems.type, type), eq(catalogItems.itemId, itemId)))
			.returning();
		if (!updated.length) throw new ApiError(404, { error: "not_found" });
		await changed();
		await audit(req.admin, "catalog.update", `${type}:${itemId}`, null, body.data);
		return { ok: true };
	});

	app.put("/admin/api/catalogs/:type/:itemId/translations/:locale", { preHandler: app.requireOwner }, async (req) => {
		const p = req.params as { type: string; itemId: string; locale: string };
		const type = typeParam.parse(p.type);
		const itemId = z.coerce.number().int().parse(p.itemId);
		const locale = localeSchema.parse(p.locale);
		const body = translationSchema.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		await db
			.insert(catalogTranslations)
			.values({ type, itemId, locale, label: body.data.label, extra: body.data.extra })
			.onConflictDoUpdate({ target: [catalogTranslations.type, catalogTranslations.itemId, catalogTranslations.locale], set: { label: body.data.label, extra: body.data.extra, updatedAt: new Date() } });
		await changed();
		await audit(req.admin, "catalog.translate", `${type}:${itemId}:${locale}`, null, body.data);
		return { ok: true };
	});

	app.delete("/admin/api/catalogs/:type/:itemId/translations/:locale", { preHandler: app.requireOwner }, async (req) => {
		const p = req.params as { type: string; itemId: string; locale: string };
		const type = typeParam.parse(p.type);
		const itemId = z.coerce.number().int().parse(p.itemId);
		const locale = localeSchema.parse(p.locale);
		await db.delete(catalogTranslations).where(and(eq(catalogTranslations.type, type), eq(catalogTranslations.itemId, itemId), eq(catalogTranslations.locale, locale)));
		await changed();
		await audit(req.admin, "catalog.translation_delete", `${type}:${itemId}:${locale}`, null, null);
		return { ok: true };
	});

	/** Export/import: one JSON with all items and translations (e.g. to translate offline). */
	app.get("/admin/api/catalogs/export", { preHandler: app.requireAdmin }, async () => serializeAll(await loadCatalog()).items);

	app.post("/admin/api/catalogs/import", { preHandler: app.requireOwner }, async (req) => {
		const body = z
			.object({
				items: z
					.array(
						z.object({
							type: typeParam,
							itemId: z.number().int().min(1),
							key: tagKey.nullable().optional(),
							parentId: z.number().int().nullable().optional(),
							sort: z.number().int().optional(),
							active: z.boolean().optional(),
							meta: metaSchema.optional(),
							translations: z.record(localeSchema, translationSchema),
						}),
					)
					.max(5000),
			})
			.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		await db.transaction(async (tx) => {
			for (const i of body.data.items) {
				const values = { key: i.key ?? null, parentId: i.parentId ?? null, sort: i.sort ?? 0, active: i.active ?? true, meta: i.meta ?? {}, updatedAt: new Date() };
				await tx.insert(catalogItems).values({ type: i.type, itemId: i.itemId, ...values }).onConflictDoUpdate({ target: [catalogItems.type, catalogItems.itemId], set: values });
				for (const [locale, t] of Object.entries(i.translations)) {
					await tx
						.insert(catalogTranslations)
						.values({ type: i.type, itemId: i.itemId, locale, label: t.label, extra: t.extra })
						.onConflictDoUpdate({ target: [catalogTranslations.type, catalogTranslations.itemId, catalogTranslations.locale], set: { label: t.label, extra: t.extra, updatedAt: new Date() } });
				}
			}
		});
		await changed();
		await audit(req.admin, "catalog.import", null, null, { items: body.data.items.length });
		return { imported: body.data.items.length };
	});
}

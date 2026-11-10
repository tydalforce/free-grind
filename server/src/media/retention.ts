import { and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { media } from "../db/schema";
import { revokeMedia } from "../lib/mediaUrls";
import { getServerSetting } from "../modules/settings/settings";
import { forgetMediaMeta } from "./lookup";
import { deletePrefix, objectKey } from "./storage";

/**
 * What gets deleted from storage (and when):
 *  - Drawer and album media (images and videos) stay until the user deletes
 *    them in the drawer / album. Then they go at once, unless still in use
 *    (another album, or a message in a chat).
 *  - Expiring pics/videos that are not in the drawer are removed by the worker
 *    `media.retention.expiringDays` after they were sent.
 *  - Nothing else is removed automatically.
 */

/** Marks media deleted, revokes its URLs and removes all its files (and a video's poster). */
export async function purgeMedia(hashes: string[]): Promise<number> {
	if (!hashes.length) return 0;
	const rows = await db
		.update(media)
		.set({ state: "deleted", deletedAt: new Date() })
		.where(and(inArray(media.hash, hashes), isNull(media.deletedAt)))
		.returning({ hash: media.hash, purpose: media.purpose, posterHash: media.posterHash });
	for (const r of rows) {
		await forgetMediaMeta(r.hash);
		await revokeMedia(r.hash);
		await deletePrefix(objectKey(r.purpose, r.hash, "")).catch(() => undefined);
		if (r.posterHash) {
			await db.update(media).set({ state: "deleted", deletedAt: new Date() }).where(inArray(media.hash, [r.posterHash]));
			await forgetMediaMeta(r.posterHash);
			await deletePrefix(objectKey(r.purpose, r.posterHash, "")).catch(() => undefined);
		}
	}
	return rows.length;
}

/** SQL: this message is an expiring pic/video. */
const isExpiring = (alias: string) =>
	sql.raw(`(${alias}.type = 'ExpiringImage' OR (${alias}.type IN ('Video', 'PrivateVideo') AND ${alias}.body->>'maxViews' IS NOT NULL))`);

/** Of `hashes`, those nothing uses anymore: no album item, drawer entry, profile slot or visible message. */
export async function unreferenced(hashes: string[]): Promise<string[]> {
	if (!hashes.length) return [];
	const rows = (await db.execute(sql`
		SELECT h AS hash FROM unnest(${`{${hashes.join(",")}}`}::text[]) AS h
		WHERE NOT EXISTS (SELECT 1 FROM album_content c WHERE c.media_hash = h)
		  AND NOT EXISTS (SELECT 1 FROM chat_drawer d WHERE d.media_hash = h)
		  AND NOT EXISTS (SELECT 1 FROM profile_media p WHERE p.media_hash = h)
		  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.media_hash = h AND NOT m.unsent)`)) as unknown as { hash: string }[];
	return rows.map((r) => r.hash);
}

/** Deletes those of `hashes` that are no longer used anywhere (after a drawer/album delete). */
export async function purgeIfUnused(hashes: string[]): Promise<number> {
	return purgeMedia(await unreferenced([...new Set(hashes)]));
}

/**
 * Worker: expiring pics/videos older than the retention period, not in the
 * drawer and not also used by a regular (non-expiring) message.
 */
export async function sweepExpiringMedia(batch = 500): Promise<number> {
	const days = (await getServerSetting<number>("media.retention.expiringDays")) ?? 1;
	if (!(days > 0)) return 0;
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	const rows = (await db.execute(sql`
		SELECT DISTINCT m.media_hash AS hash
		FROM messages m
		JOIN media md ON md.hash = m.media_hash AND md.deleted_at IS NULL
		WHERE m.media_hash IS NOT NULL AND m.created_at < ${cutoff}::timestamptz AND ${isExpiring("m")}
		  AND NOT EXISTS (SELECT 1 FROM chat_drawer d WHERE d.media_hash = m.media_hash)
		  AND NOT EXISTS (SELECT 1 FROM album_content c WHERE c.media_hash = m.media_hash)
		  AND NOT EXISTS (
			SELECT 1 FROM messages m2
			WHERE m2.media_hash = m.media_hash AND NOT m2.unsent
			  AND (NOT ${isExpiring("m2")} OR m2.created_at >= ${cutoff}::timestamptz))
		LIMIT ${batch}`)) as unknown as { hash: string }[];
	return purgeMedia(rows.map((r) => r.hash));
}

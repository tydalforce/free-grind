import { eq } from "drizzle-orm";
import { invalidate, localCache } from "../cache/local";
import { db } from "../db/client";
import { media } from "../db/schema";

/** Hot-path media metadata for the CDN routes, cached per instance (invalidated on change). */
export type MediaMeta = { hash: string; ownerId: string; kind: "image" | "video" | "audio"; purpose: string; state: string; posterHash: string | null; mime: string; deleted: boolean };

const cache = localCache<MediaMeta | null>("media-meta", { ttlMs: 5 * 60_000, max: 100_000 });

export async function mediaMeta(hash: string): Promise<MediaMeta | null> {
	if (!/^[a-f0-9]{32,64}$/.test(hash)) return null;
	return cache.getOrLoad(hash, async () => {
		const [row] = await db.select().from(media).where(eq(media.hash, hash)).limit(1);
		if (!row) return null;
		return { hash: row.hash, ownerId: String(row.ownerId), kind: row.kind, purpose: row.purpose, state: row.state, posterHash: row.posterHash, mime: row.mime, deleted: !!row.deletedAt };
	});
}

export async function forgetMediaMeta(hash: string): Promise<void> {
	await invalidate("media-meta", hash);
}

import { asc, eq, inArray, isNull, and } from "drizzle-orm";
import { redis } from "../cache/redis";
import { db } from "../db/client";
import { media, profileMedia, profiles, users } from "../db/schema";

/**
 * Viewer-independent profile data, cached in Redis as `pcard:<id>` and read
 * in bulk with MGET (grid, inbox, taps, views, requests). Viewer-dependent
 * parts (distance, favorite, block state) are added by the serializers.
 */
export type ProfileCard = {
	profileId: string;
	displayName: string | null;
	aboutMe: string | null;
	age: number | null;
	showAge: boolean;
	showDistance: boolean;
	showPosition: boolean;
	showTribes: boolean;
	approximateDistance: boolean;
	nsfw: number | null;
	bodyType: number | null;
	ethnicity: number | null;
	hivStatus: number | null;
	lastTestedDate: number | null;
	relationshipStatus: number | null;
	sexualPosition: number | null;
	heightCm: number | null;
	weightGrams: number | null;
	genders: number[];
	pronouns: number[];
	tribes: number[];
	tribesImInto: number[];
	lookingFor: number[];
	meetAt: number[];
	vaccines: number[];
	sexualHealth: number[];
	profileTags: string[];
	extra: Record<string, unknown>;
	primaryMediaHash: string | null;
	medias: { mediaHash: string; kind: "image" | "video" | "audio"; state: string; takenOnGrindr: boolean; createdAt: number; posterHash: string | null; durationMs: number | null }[];
	createdAt: number;
	lastUpdatedTime: number;
	deleted: boolean;
	banned: boolean;
};

const KEY = (id: bigint | string) => `pcard:${id}`;
const TTL_SECONDS = 600;

export function ageFrom(birthday: Date, now = new Date()): number {
	let age = now.getUTCFullYear() - birthday.getUTCFullYear();
	const m = now.getUTCMonth() - birthday.getUTCMonth();
	if (m < 0 || (m === 0 && now.getUTCDate() < birthday.getUTCDate())) age--;
	return age;
}

async function buildCards(ids: bigint[]): Promise<Map<string, ProfileCard>> {
	if (!ids.length) return new Map();
	const rows = await db
		.select({ p: profiles, u: { id: users.id, birthday: users.birthday, deletedAt: users.deletedAt, bannedUntil: users.bannedUntil, createdAt: users.createdAt } })
		.from(users)
		.leftJoin(profiles, eq(profiles.userId, users.id))
		.where(inArray(users.id, ids));
	const mediaRows = await db
		.select({ userId: profileMedia.userId, hash: media.hash, kind: media.kind, state: media.state, takenOnGrindr: media.takenOnGrindr, createdAt: media.createdAt, posterHash: media.posterHash, durationMs: media.durationMs, position: profileMedia.position })
		.from(profileMedia)
		.innerJoin(media, eq(media.hash, profileMedia.mediaHash))
		.where(and(inArray(profileMedia.userId, ids), isNull(media.deletedAt)))
		.orderBy(asc(profileMedia.userId), asc(profileMedia.position));
	const mediaBy = new Map<string, ProfileCard["medias"]>();
	for (const m of mediaRows) {
		const list = mediaBy.get(String(m.userId)) ?? [];
		list.push({ mediaHash: m.hash, kind: m.kind, state: m.state, takenOnGrindr: m.takenOnGrindr, createdAt: m.createdAt.getTime(), posterHash: m.posterHash, durationMs: m.durationMs });
		mediaBy.set(String(m.userId), list);
	}
	const out = new Map<string, ProfileCard>();
	for (const { p, u } of rows) {
		const id = String(u.id);
		// Postgres 'infinity' arrives as Infinity / an invalid Date.
		const until = u.bannedUntil ? u.bannedUntil.getTime() : null;
		const banned = until != null && (Number.isNaN(until) || until > Date.now());
		out.set(id, {
			profileId: id,
			displayName: p?.displayName ?? null,
			aboutMe: p?.aboutMe ?? null,
			age: ageFrom(u.birthday),
			showAge: p?.showAge ?? true,
			showDistance: p?.showDistance ?? true,
			showPosition: p?.showPosition ?? true,
			showTribes: p?.showTribes ?? true,
			approximateDistance: p?.approximateDistance ?? false,
			nsfw: p?.nsfw ?? null,
			bodyType: p?.bodyType ?? null,
			ethnicity: p?.ethnicity ?? null,
			hivStatus: p?.hivStatus ?? null,
			lastTestedDate: p?.lastTestedDate ?? null,
			relationshipStatus: p?.relationshipStatus ?? null,
			sexualPosition: p?.sexualPosition ?? null,
			heightCm: p?.heightCm ?? null,
			weightGrams: p?.weightGrams ?? null,
			genders: p?.genders ?? [],
			pronouns: p?.pronouns ?? [],
			tribes: p?.tribes ?? [],
			tribesImInto: p?.tribesImInto ?? [],
			lookingFor: p?.lookingFor ?? [],
			meetAt: p?.meetAt ?? [],
			vaccines: p?.vaccines ?? [],
			sexualHealth: p?.sexualHealth ?? [],
			profileTags: p?.profileTags ?? [],
			extra: (p?.extra as Record<string, unknown>) ?? {},
			primaryMediaHash: p?.primaryMediaHash ?? null,
			medias: mediaBy.get(id) ?? [],
			createdAt: (p?.createdAt ?? u.createdAt).getTime(),
			lastUpdatedTime: (p?.updatedAt ?? u.createdAt).getTime(),
			deleted: !!u.deletedAt,
			banned,
		});
	}
	return out;
}

/** Cards for many profiles: one MGET, DB only for misses (then cached). */
export async function getProfileCards(ids: (bigint | string)[]): Promise<Map<string, ProfileCard>> {
	const unique = [...new Set(ids.map(String))];
	if (!unique.length) return new Map();
	const cached = await redis.mget(...unique.map(KEY));
	const out = new Map<string, ProfileCard>();
	const misses: bigint[] = [];
	unique.forEach((id, i) => {
		const raw = cached[i];
		if (raw) out.set(id, JSON.parse(raw) as ProfileCard);
		else misses.push(BigInt(id));
	});
	if (misses.length) {
		const built = await buildCards(misses);
		const pipeline = redis.pipeline();
		for (const [id, card] of built) {
			out.set(id, card);
			pipeline.set(KEY(id), JSON.stringify(card), "EX", TTL_SECONDS);
		}
		await pipeline.exec();
	}
	return out;
}

export async function getProfileCard(id: bigint | string): Promise<ProfileCard | null> {
	return (await getProfileCards([id])).get(String(id)) ?? null;
}

export async function invalidateProfileCard(id: bigint | string): Promise<void> {
	await redis.del(KEY(id));
}

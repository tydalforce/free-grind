import { config } from "../config";
import { displayedDistance } from "../geo/obfuscate";
import { MEDIA_STATE_CODE, MEDIA_TYPE_CODE } from "../media/service";
import type { ProfileCard } from "./cards";
import { mediaBase } from "../lib/publicUrls";

export type ViewerContext = {
	isSelf: boolean;
	isVisiting?: boolean;
	/** Meters between public positions, or null when unknown. */
	distanceMeters: number | null;
	isFavorite: boolean;
	onlineUntil: number | null;
	seen: number | null;
	roundMeters: number;
	tapType?: number | null;
	lastReceivedTapTimestamp?: number | null;
};

/** Upstream ProfileMedia list; videos carry our extension fields. */
export function serializeMedias(card: ProfileCard) {
	return card.medias.map((m) => ({
		mediaHash: m.mediaHash,
		type: MEDIA_TYPE_CODE[m.kind],
		state: MEDIA_STATE_CODE[m.state as keyof typeof MEDIA_STATE_CODE] ?? 0,
		reason: null,
		takenOnGrindr: m.takenOnGrindr,
		createdAt: m.createdAt,
		...(m.kind === "video"
			? { videoUrl: `${mediaBase()}/videos/profile/${m.mediaHash}.mp4`, posterHash: m.posterHash, durationMs: m.durationMs }
			: {}),
	}));
}

export function shownDistance(card: ProfileCard, ctx: ViewerContext): number | null {
	if (ctx.isSelf) return 0;
	if (!card.showDistance || ctx.distanceMeters == null) return null;
	return displayedDistance(ctx.distanceMeters, { roundMeters: ctx.roundMeters, approximate: card.approximateDistance });
}

/** GET /v7/profiles/{id}, /v4/me/profile, POST /v3/profiles element. */
export function serializeProfileDetail(card: ProfileCard, ctx: ViewerContext) {
	const extra = card.extra ?? {};
	return {
		profileId: card.profileId,
		displayName: card.displayName,
		aboutMe: card.aboutMe,
		age: card.showAge || ctx.isSelf ? card.age : null,
		showAge: card.showAge,
		showDistance: card.showDistance,
		showPosition: card.showPosition,
		showTribes: card.showTribes,
		approximateDistance: card.approximateDistance,
		distance: shownDistance(card, ctx),
		isFavorite: ctx.isFavorite,
		onlineUntil: ctx.isSelf ? null : ctx.onlineUntil,
		seen: ctx.isSelf ? null : ctx.seen,
		lastViewed: null,
		lastChatTimestamp: 0,
		isNew: Date.now() - card.createdAt < 7 * 86_400_000,
		lastUpdatedTime: card.lastUpdatedTime,
		created: card.createdAt,
		profileImageMediaHash: card.primaryMediaHash,
		medias: serializeMedias(card),
		nsfw: card.nsfw,
		bodyType: card.bodyType,
		ethnicity: card.ethnicity,
		hivStatus: card.hivStatus,
		lastTestedDate: card.lastTestedDate,
		relationshipStatus: card.relationshipStatus,
		sexualPosition: card.showPosition || ctx.isSelf ? card.sexualPosition : null,
		height: card.heightCm,
		weight: card.weightGrams,
		genders: card.genders,
		pronouns: card.pronouns,
		grindrTribes: card.showTribes || ctx.isSelf ? card.tribes : [],
		tribesImInto: card.tribesImInto,
		lookingFor: card.lookingFor,
		meetAt: card.meetAt,
		vaccines: card.vaccines,
		sexualHealth: card.sexualHealth,
		profileTags: card.profileTags,
		hashtags: [],
		socialNetworks: extra.socialNetworks ?? {},
		identity: null,
		isBlockable: !ctx.isSelf,
		tapped: ctx.tapType != null,
		tapType: ctx.tapType ?? null,
		lastReceivedTapTimestamp: ctx.lastReceivedTapTimestamp ?? null,
		unreadCount: 0,
		isTeleporting: false,
		isRoaming: false,
		isVisiting: ctx.isVisiting ?? false,
		travelPlans: [],
		rightNow: "NOT_ACTIVE",
		rightNowStatus: "NONE",
		foundVia: "UNKNOWN",
	};
}

/** Upstream stub for a profile that is blocked ("4") or gone ("3"); see client profileAccessStatus.ts. */
export function profileStub(profileId: string, reason: "blocked" | "gone") {
	return {
		profileId,
		displayName: reason === "blocked" ? "4" : "3",
		lastUpdatedTime: null,
		age: null,
		distance: null,
		onlineUntil: null,
		seen: null,
		profileImageMediaHash: null,
		medias: [],
		isFavorite: false,
		profileTags: [],
		hashtags: [],
	};
}

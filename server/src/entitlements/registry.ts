/**
 * Every limit the server knows (plan 6a). Adding a key here makes it
 * configurable per role and per user in the admin UI; nothing else needed.
 *
 * Value shapes (stored as JSONB):
 *  - boolean:  true | false
 *  - cap:      { unlimited: true } | { max: number }
 *  - duration: { unlimited: true } | { seconds: number }
 *  - quota:    { unlimited: true } | { windows: QuotaWindow[] }
 *  - list:     { unlimited: true } | { values: string[] }
 */

export type QuotaWindow =
	| { count: number; window: "day" | "week" | "month" }
	| { count: number; window: "rolling"; seconds: number }
	| { count: number; window: "refill"; everySeconds: number; max: number };

export type EntitlementValue =
	| boolean
	| { unlimited: true }
	| { max: number }
	| { seconds: number }
	| { windows: QuotaWindow[] }
	| { values: string[] };

export type EntitlementType = "boolean" | "cap" | "duration" | "quota" | "list";

export type EntitlementDef = {
	key: string;
	type: EntitlementType;
	group: "albums" | "chat" | "profile" | "videocall" | "rightnow" | "browse";
	unit?: "count" | "bytes" | "ms" | "seconds" | "meters";
	description: string;
	/** Default for the "default" profile. Everything is unlimited unless noted. */
	default: EntitlementValue;
	/** Boolean entitlements mirrored into the JWT `features` claim. */
	feature?: string;
	/** For list entitlements: allowed values. */
	options?: readonly string[];
};

const UNLIMITED = { unlimited: true } as const;

const MESSAGE_TYPES = [
	"Text",
	"Image",
	"ExpiringImage",
	"Video",
	"PrivateVideo",
	"NonExpiringVideo",
	"Audio",
	"Location",
	"Giphy",
	"Gaymoji",
	"Album",
	"ExpiringAlbum",
	"ExpiringAlbumV2",
	"AlbumContentReaction",
	"AlbumContentReply",
	"ProfilePhotoReply",
] as const;

export const ALBUM_EXPIRATION_TYPES = ["INDEFINITE", "ONCE", "TEN_MINUTES", "ONE_HOUR", "ONE_DAY"] as const;

const defs: EntitlementDef[] = [
	// --- Albums ---
	{ key: "albums.maxCount", type: "cap", group: "albums", unit: "count", description: "Anzahl Alben", default: UNLIMITED },
	{ key: "albums.maxItemsPerAlbum", type: "cap", group: "albums", unit: "count", description: "Inhalte pro Album gesamt", default: UNLIMITED },
	{ key: "albums.maxImagesPerAlbum", type: "cap", group: "albums", unit: "count", description: "Bilder pro Album", default: UNLIMITED },
	{ key: "albums.maxVideosPerAlbum", type: "cap", group: "albums", unit: "count", description: "Videos pro Album", default: UNLIMITED },
	{ key: "albums.video.maxDurationMs", type: "cap", group: "albums", unit: "ms", description: "Max. Länge Album-Video", default: UNLIMITED },
	{ key: "albums.video.minDurationMs", type: "cap", group: "albums", unit: "ms", description: "Min. Länge Album-Video", default: { max: 0 } },
	{ key: "albums.video.maxBytes", type: "cap", group: "albums", unit: "bytes", description: "Max. Größe Album-Video", default: UNLIMITED },
	{ key: "albums.image.maxBytes", type: "cap", group: "albums", unit: "bytes", description: "Max. Größe Album-Bild", default: UNLIMITED },
	{ key: "albums.maxStorageBytes", type: "cap", group: "albums", unit: "bytes", description: "Album-Speicher gesamt", default: UNLIMITED },
	{ key: "albums.uploadsPerDay", type: "quota", group: "albums", description: "Album-Uploads", default: UNLIMITED },
	{ key: "albums.share", type: "boolean", group: "albums", description: "Alben teilen", default: true },
	{ key: "albums.maxSharesPerAlbum", type: "cap", group: "albums", unit: "count", description: "Empfänger pro Album", default: UNLIMITED },
	{ key: "albums.sharesPerDay", type: "quota", group: "albums", description: "Neue Shares", default: UNLIMITED },
	{ key: "albums.maxShareableAlbums", type: "cap", group: "albums", unit: "count", description: "Gleichzeitig geteilte eigene Alben", default: UNLIMITED },
	{ key: "albums.maxViewableAlbums", type: "cap", group: "albums", unit: "count", description: "Öffenbare fremde Alben", default: UNLIMITED },
	{ key: "albums.maxViewableVideos", type: "cap", group: "albums", unit: "count", description: "Öffenbare fremde Album-Videos", default: UNLIMITED },
	{ key: "albums.expiringShares", type: "boolean", group: "albums", description: "Expiring-Album-Shares", default: true },
	{ key: "albums.expiringShares.perDay", type: "quota", group: "albums", description: "Expiring-Album-Shares (Empfänger)", default: UNLIMITED },
	{ key: "albums.allowedExpirationTypes", type: "list", group: "albums", description: "Erlaubte expirationTypes", default: UNLIMITED, options: ALBUM_EXPIRATION_TYPES },

	// --- Chat & media ---
	{ key: "chat.expiringImages.enabled", type: "boolean", group: "chat", description: "Expiring Pics senden", default: true },
	{ key: "chat.expiringVideos.enabled", type: "boolean", group: "chat", description: "Expiring Videos senden", default: true },
	{ key: "chat.expiringImages.perDay", type: "quota", group: "chat", description: "Expiring Pics", default: UNLIMITED },
	{ key: "chat.expiringVideos.perDay", type: "quota", group: "chat", description: "Expiring Videos", default: UNLIMITED },
	{ key: "chat.expiring.maxViews", type: "cap", group: "chat", unit: "count", description: "Max. Views pro Expiring-Medium", default: UNLIMITED },
	{ key: "chat.expiring.durationSec", type: "cap", group: "chat", unit: "seconds", description: "Anzeigedauer Expiring-Medium", default: UNLIMITED },
	{ key: "chat.mediaUploads.perDay", type: "quota", group: "chat", description: "Chat-Uploads", default: UNLIMITED },
	{ key: "chat.image.maxBytes", type: "cap", group: "chat", unit: "bytes", description: "Max. Bildgröße Chat", default: UNLIMITED },
	{ key: "chat.video.maxBytes", type: "cap", group: "chat", unit: "bytes", description: "Max. Videogröße Chat", default: UNLIMITED },
	{ key: "chat.video.maxDurationMs", type: "cap", group: "chat", unit: "ms", description: "Max. Videolänge Chat", default: UNLIMITED },
	{ key: "chat.audio.maxDurationMs", type: "cap", group: "chat", unit: "ms", description: "Max. Audiolänge", default: UNLIMITED },
	{ key: "chat.video.send", type: "boolean", group: "chat", description: "Videos im Chat senden", default: true },
	{ key: "chat.messageTypes", type: "list", group: "chat", description: "Erlaubte Nachrichtentypen", default: UNLIMITED, options: MESSAGE_TYPES },
	{ key: "chat.messagesPerMinute", type: "quota", group: "chat", description: "Anti-Spam-Rate", default: { windows: [{ count: 120, window: "rolling", seconds: 60 }] } },
	{ key: "chat.newConversationsPerDay", type: "quota", group: "chat", description: "Neue Chats", default: UNLIMITED },
	{ key: "chat.unsend", type: "boolean", group: "chat", description: "Nachrichten zurückziehen", default: true },
	{ key: "chat.unsend.perDay", type: "quota", group: "chat", description: "Unsends", default: UNLIMITED },
	{ key: "chat.unsend.maxAgeSec", type: "duration", group: "chat", description: "Max. Nachrichtenalter für Unsend", default: UNLIMITED },
	{ key: "chat.delete", type: "boolean", group: "chat", description: "Nachricht für sich löschen", default: true },
	{ key: "chat.readReceipts", type: "boolean", group: "chat", description: "Lesebestätigungen", default: true },
	{ key: "chat.typingIndicator", type: "boolean", group: "chat", description: "Tippanzeige", default: true },
	{ key: "chat.reactions", type: "boolean", group: "chat", description: "Reaktionen", default: true },
	{ key: "chat.translate", type: "boolean", group: "chat", description: "Server-Übersetzung", default: true },
	{ key: "chat.savedPhrases.max", type: "cap", group: "chat", unit: "count", description: "Gespeicherte Phrasen", default: UNLIMITED },
	{ key: "chat.pinned.max", type: "cap", group: "chat", unit: "count", description: "Angepinnte Conversations", default: UNLIMITED },
	{ key: "chat.inboxFilters", type: "boolean", group: "chat", description: "Inbox-Filter", default: true },

	// --- Profile ---
	{ key: "profile.images.max", type: "cap", group: "profile", unit: "count", description: "Profilmedien gesamt", default: { max: 5 } },
	{ key: "profile.videos.enabled", type: "boolean", group: "profile", description: "Profilvideos", default: true },
	{ key: "profile.videos.max", type: "cap", group: "profile", unit: "count", description: "Profilvideos", default: { max: 5 } },
	{ key: "profile.video.maxDurationMs", type: "cap", group: "profile", unit: "ms", description: "Max. Länge Profilvideo", default: { max: 30_000 } },
	{ key: "profile.video.maxBytes", type: "cap", group: "profile", unit: "bytes", description: "Max. Größe Profilvideo", default: { max: 50 * 1024 * 1024 } },
	{ key: "profile.images.uploadsPerDay", type: "quota", group: "profile", description: "Profilbild-Uploads", default: UNLIMITED },
	{ key: "user.totalStorageBytes", type: "cap", group: "profile", unit: "bytes", description: "Gesamtspeicher", default: UNLIMITED },

	// --- Video calls ---
	{ key: "videocall.enabled", type: "boolean", group: "videocall", description: "Videocalls starten", default: true, feature: "CreateVideoCall" },
	{ key: "videocall.receive", type: "boolean", group: "videocall", description: "Anrufe annehmen", default: true },
	{ key: "videocall.dailySeconds", type: "quota", group: "videocall", description: "Sekunden pro Tag", default: UNLIMITED },
	{ key: "videocall.monthlySeconds", type: "quota", group: "videocall", description: "Sekunden pro Monat", default: UNLIMITED },
	{ key: "videocall.callsPerDay", type: "quota", group: "videocall", description: "Gestartete Calls", default: UNLIMITED },
	{ key: "videocall.maxCallSeconds", type: "duration", group: "videocall", description: "Max. Dauer pro Call", default: UNLIMITED },

	// --- Right Now ---
	{ key: "rightnow.posts", type: "quota", group: "rightnow", description: "Neue Right-Now-Sessions", default: UNLIMITED },
	{ key: "rightnow.postDuration", type: "duration", group: "rightnow", description: "Laufzeit einer Session", default: { seconds: 3600 } },
	{ key: "rightnow.renewsPerSession", type: "cap", group: "rightnow", unit: "count", description: "Verlängerungen pro Session", default: { max: 0 } },
	{ key: "rightnow.maxActivePosts", type: "cap", group: "rightnow", unit: "count", description: "Gleichzeitig aktive Posts", default: { max: 1 } },
	{ key: "rightnow.discreet", type: "boolean", group: "rightnow", description: "Diskrete Posts", default: true },
	{ key: "rightnow.feedUnlocked", type: "boolean", group: "rightnow", description: "Feed unverschleiert", default: true },
	{ key: "rightnow.feedVisiblePosts", type: "cap", group: "rightnow", unit: "count", description: "Voll sichtbare Posts", default: UNLIMITED },
	{ key: "rightnow.requestsPerDay", type: "quota", group: "rightnow", description: "Connect-Requests", default: UNLIMITED },

	// --- Browse & interaction ---
	{ key: "grid.pageSize", type: "cap", group: "browse", unit: "count", description: "Profile pro Seite", default: { max: 100 } },
	{ key: "grid.maxPages", type: "cap", group: "browse", unit: "count", description: "Grid-Tiefe (Seiten)", default: UNLIMITED },
	{ key: "grid.filters", type: "boolean", group: "browse", description: "Erweiterte Filter", default: true },
	{ key: "taps.perDay", type: "quota", group: "browse", description: "Taps", default: UNLIMITED },
	{ key: "favorites.max", type: "cap", group: "browse", unit: "count", description: "Favoriten", default: UNLIMITED },
	{ key: "blocks.max", type: "cap", group: "browse", unit: "count", description: "Blockierte Profile", default: UNLIMITED },
	{ key: "viewedMe.visibleCount", type: "cap", group: "browse", unit: "count", description: "Sichtbare Viewed-me-Einträge", default: UNLIMITED },
	{ key: "incognito", type: "boolean", group: "browse", description: "Inkognito", default: true },
	{ key: "travel.plans.max", type: "cap", group: "browse", unit: "count", description: "Reisepläne", default: UNLIMITED },
];

export const ENTITLEMENTS: ReadonlyMap<string, EntitlementDef> = new Map(defs.map((d) => [d.key, d]));

export function getEntitlementDef(key: string): EntitlementDef {
	const def = ENTITLEMENTS.get(key);
	if (!def) throw new Error(`unknown entitlement ${key}`);
	return def;
}

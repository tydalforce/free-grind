import { SignJWT } from "jose";
import { getServerSetting } from "../modules/settings/settings";

/**
 * Self-hosted LiveKit (plan: video calls without Agora). Configured in the
 * admin integrations: public WebSocket URL, API key, API secret (encrypted).
 * Access tokens are LiveKit's HS256 JWTs (iss = API key, sub = identity,
 * `video` grant for exactly one room); room control uses its Twirp API.
 */

export type LiveKitConfig = { url: string; apiKey: string; apiSecret: string };

export async function loadLiveKit(): Promise<LiveKitConfig | null> {
	const [url, apiKey, apiSecret] = await Promise.all([
		getServerSetting<string>("livekit.url"),
		getServerSetting<string>("livekit.apiKey"),
		getServerSetting<string>("livekit.apiSecret"),
	]);
	if (!url || !apiKey || !apiSecret) return null;
	return { url, apiKey, apiSecret };
}

type VideoGrant = { room?: string; roomJoin?: boolean; canPublish?: boolean; canSubscribe?: boolean; roomCreate?: boolean; roomList?: boolean; roomAdmin?: boolean };

async function sign(cfg: LiveKitConfig, claims: { identity?: string; name?: string; video: VideoGrant }, ttlSeconds: number): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const jwt = new SignJWT({ video: claims.video, ...(claims.name ? { name: claims.name } : {}) })
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuer(cfg.apiKey)
		.setNotBefore(now - 10)
		.setExpirationTime(now + ttlSeconds);
	if (claims.identity) jwt.setSubject(claims.identity).setJti(`${claims.identity}-${now}`);
	return jwt.sign(new TextEncoder().encode(cfg.apiSecret));
}

/** Token to join one room; valid for the call's maximum length plus a little slack. */
export function joinToken(cfg: LiveKitConfig, room: string, identity: string, ttlSeconds: number, name?: string): Promise<string> {
	return sign(cfg, { identity, name, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } }, Math.max(60, ttlSeconds));
}

/** HTTP(S) base of the LiveKit server for its Twirp API (from the ws(s) URL). */
function httpBase(cfg: LiveKitConfig): string {
	return cfg.url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "");
}

async function twirp(cfg: LiveKitConfig, method: string, body: unknown, video: VideoGrant): Promise<Response> {
	return fetch(`${httpBase(cfg)}/twirp/livekit.RoomService/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${await sign(cfg, { video }, 60)}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000),
	});
}

/** Ends a call for everyone in it (best effort: an empty room is gone anyway). */
export async function deleteRoom(cfg: LiveKitConfig, room: string): Promise<void> {
	await twirp(cfg, "DeleteRoom", { room }, { roomCreate: true }).catch(() => undefined);
}

/** Admin "test": credentials accepted and server reachable. */
export async function testLiveKit(cfg: LiveKitConfig): Promise<{ ok: true; rooms: number } | { ok: false; error: string }> {
	try {
		const res = await twirp(cfg, "ListRooms", {}, { roomList: true });
		if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
		const body = (await res.json()) as { rooms?: unknown[] };
		return { ok: true, rooms: body.rooms?.length ?? 0 };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

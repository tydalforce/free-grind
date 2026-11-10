import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide } from "../../src/geo/visiting";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { adminPasswordOpts } from "../../src/admin/auth";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { admins, userWarnings } from "../../src/db/schema";
import { decodeGeohash, destination, encodeGeohash } from "../../src/geo/obfuscate";
import { clientHeaders, randomIp, registerAndLogin } from "../helpers";

let app: FastifyInstance;
type Session = Awaited<ReturnType<typeof registerAndLogin>>;
const ADMIN = `acc_${randomUUID().slice(0, 8)}`;
const ADMIN_PW = "very-long-admin-password";
let cookie = "";

beforeAll(async () => {
	app = await buildApp();
	await db.insert(admins).values({ username: ADMIN, passwordHash: await Bun.password.hash(ADMIN_PW, adminPasswordOpts), role: "owner" });
	const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: ADMIN, password: ADMIN_PW }, headers: { "x-forwarded-for": randomIp() } });
	cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterAll(async () => {
	await db.delete(admins).where(eq(admins.username, ADMIN));
	await app.close();
});

const h = (s: Session, extra: Record<string, string> = {}) => ({ ...clientHeaders({ deviceId: s.deviceId, token: s.sessionId }), ...extra });
const admin = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
	app.inject({ method, url, payload: payload as object, headers: { cookie, ...(method !== "GET" ? { "x-admin-request": "1" } : {}) } });

describe("catalogs", () => {
	test("genders and pronouns follow L-Locale; tags come per language", async () => {
		const s = await registerAndLogin(app);
		const de = await app.inject({ method: "GET", url: "/public/v2/genders", headers: { ...clientHeaders(), "l-locale": "de_DE", "accept-language": "de-DE" } });
		expect(de.headers["content-language"]).toBe("de-DE");
		expect(de.json().find((g: { genderId: number }) => g.genderId === 1).gender).toBe("Mann");
		const en = await app.inject({ method: "GET", url: "/public/v2/genders", headers: { ...clientHeaders(), "l-locale": "en_US", "accept-language": "en-US" } });
		expect(en.json().find((g: { genderId: number }) => g.genderId === 1)).toMatchObject({ gender: "Man", genderPlural: "Men", displayGroup: 1 });
		// Unknown language falls back to the default (en).
		const fr = await app.inject({ method: "GET", url: "/public/v2/genders", headers: { ...clientHeaders(), "l-locale": "fr_FR", "accept-language": "fr-FR" } });
		expect(fr.json()[0].gender).toBe("Man");
		// ETag → 304.
		const again = await app.inject({ method: "GET", url: "/public/v2/genders", headers: { ...clientHeaders(), "l-locale": "en_US", "accept-language": "en-US", "if-none-match": String(en.headers.etag) } });
		expect(again.statusCode).toBe(304);

		expect((await app.inject({ method: "GET", url: "/v1/pronouns", headers: h(s) })).json().some((p: { pronoun: string }) => p.pronoun === "Sie/Ihr")).toBe(true);
		const tags = (await app.inject({ method: "GET", url: "/v1/tags", headers: h(s) })).json() as { language: string; categoryCollection: { text: string; tags: { key: string }[] }[] }[];
		expect(tags.map((t) => t.language).sort()).toEqual(["de", "en"]);
		expect(tags.find((t) => t.language === "en")!.categoryCollection[0]!.tags.some((t) => t.key === "music")).toBe(true);
	});

	test("profile saves keep only active catalog entries", async () => {
		const s = await registerAndLogin(app);
		await app.inject({ method: "PATCH", url: "/v4/me/profile", headers: h(s), payload: { genders: [1, 999], pronouns: [2, 777], profileTags: ["music", "not-a-tag"] } });
		const me = (await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).json().profiles[0];
		expect(me).toMatchObject({ genders: [1], pronouns: [2], profileTags: ["music"] });
	});

	test("admin: add a gender with translations, deactivate it, coverage + export", async () => {
		const created = await admin("POST", "/admin/api/catalogs/gender", { meta: { displayGroup: 3 }, translations: { en: { label: "Test gender" }, de: { label: "Testgeschlecht" } } });
		expect(created.statusCode).toBe(200);
		const id = created.json().itemId as number;
		const list = (await app.inject({ method: "GET", url: "/public/v2/genders", headers: { ...clientHeaders(), "l-locale": "de_DE", "accept-language": "de-DE" } })).json();
		expect(list.some((g: { genderId: number; gender: string }) => g.genderId === id && g.gender === "Testgeschlecht")).toBe(true);
		await admin("PUT", `/admin/api/catalogs/gender/${id}`, { active: false });
		const after = (await app.inject({ method: "GET", url: "/public/v2/genders", headers: clientHeaders() })).json();
		expect(after.some((g: { genderId: number }) => g.genderId === id)).toBe(false);
		const all = (await admin("GET", "/admin/api/catalogs")).json();
		expect(all.coverage.en).toBe(100);
		expect(Array.isArray((await admin("GET", "/admin/api/catalogs/export")).json())).toBe(true);
	});
});

describe("favorites & notes", () => {
	test("notes only on favorites; unfavoriting removes the note; favorites grid includes far-away favorites", async () => {
		const me = await registerAndLogin(app);
		const fav = await registerAndLogin(app);
		const base = { lat: -30 + Math.random() * 5, lon: 140 + Math.random() * 5 };
		await app.inject({ method: "PUT", url: "/v4/location", headers: h(me), payload: { geohash: encodeGeohash(base) } });
		// 3000 km away: never among the nearest candidates.
		await app.inject({ method: "PUT", url: "/v4/location", headers: h(fav), payload: { geohash: encodeGeohash(destination(base, 3_000_000, 1)) } });

		expect((await app.inject({ method: "PUT", url: `/v1/favorites/notes/${fav.profileId}`, headers: h(me), payload: { notes: "x", phoneNumber: "" } })).statusCode).toBe(404);
		expect((await app.inject({ method: "GET", url: `/v1/favorites/notes/${fav.profileId}`, headers: h(me) })).json()).toEqual({ notes: "", phoneNumber: "" });

		expect((await app.inject({ method: "POST", url: `/v3/me/favorites/${fav.profileId}`, headers: h(me) })).statusCode).toBe(200);
		expect((await app.inject({ method: "PUT", url: `/v1/favorites/notes/${fav.profileId}`, headers: h(me), payload: { notes: "Met at the lake", phoneNumber: "+49 170 0000000" } })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: "/v1/favorites/notes", headers: h(me) })).json()).toEqual([{ counterpartyId: fav.profileId, notes: "Met at the lake", phoneNumber: "+49 170 0000000" }]);

		const grid = await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${encodeGeohash(base)}&favorites=true`, headers: h(me) });
		const ids = (grid.json().items as { data: { profileId: number; favorite: boolean } }[]).map((i) => String(i.data.profileId));
		expect(ids).toEqual([fav.profileId]);

		await app.inject({ method: "DELETE", url: `/v3/me/favorites/${fav.profileId}`, headers: h(me) });
		expect((await app.inject({ method: "GET", url: "/v1/favorites/notes", headers: h(me) })).json()).toEqual([]);
		expect((await app.inject({ method: "POST", url: `/v3/me/favorites/${me.profileId}`, headers: h(me) })).statusCode).toBe(400);
	});
});

describe("legal, warnings, visiting", () => {
	test("legal versions and acceptance; consents only added", async () => {
		const s = await registerAndLogin(app);
		const info = (await app.inject({ method: "GET", url: "/v3/legal-agreements", headers: clientHeaders() })).json().legalAgreements;
		expect(info.termsOfServiceUrl).toContain("/legal/terms");
		expect(info.latestTermsOfServiceVersion).toBe("20261110");
		expect((await app.inject({ method: "GET", url: "/legal/terms" })).headers["content-type"]).toContain("text/html");
		expect((await app.inject({ method: "GET", url: "/v3/me/legal-agreements", headers: h(s) })).json().termsOfServiceVersion).toBeNull();
		await app.inject({ method: "PUT", url: "/v3/me/legal-agreements", headers: h(s), payload: { termsOfServiceVersion: 20261110, privacyPolicyVersion: 20261110, userConsentList: ["HIV_COLLECT"] } });
		await app.inject({ method: "PUT", url: "/v3/me/legal-agreements", headers: h(s), payload: { termsOfServiceVersion: 20261110, privacyPolicyVersion: 20261110, userConsentList: [] } });
		const accepted = (await app.inject({ method: "GET", url: "/v3/me/legal-agreements", headers: h(s) })).json();
		expect(accepted).toMatchObject({ termsOfServiceVersion: "20261110", userConsentList: ["HIV_COLLECT"] });
		expect(typeof accepted.createdAtTermsAgreement).toBe("number");
	});

	test("admin warning shows in the app until acknowledged", async () => {
		const s = await registerAndLogin(app);
		expect((await admin("POST", `/admin/api/users/${s.profileId}/warnings`, { warning: "MILD_INSULTS" })).statusCode).toBe(200);
		await admin("POST", `/admin/api/users/${s.profileId}/warnings`, { warning: "MILD_INSULTS" });
		expect((await admin("POST", `/admin/api/users/${s.profileId}/warnings`, { warning: "MADE_UP" })).statusCode).toBe(400);
		expect((await app.inject({ method: "GET", url: "/v2/warnings", headers: h(s) })).json()).toEqual({ warnings: [{ warning: "MILD_INSULTS", count: 2 }] });
		await app.inject({ method: "PUT", url: "/v1/warnings", headers: h(s) });
		expect((await app.inject({ method: "GET", url: "/v2/warnings", headers: h(s) })).json()).toEqual({ warnings: [] });
		await db.delete(userWarnings).where(eq(userWarnings.userId, BigInt(s.profileId)));
	});

	test("visiting: mode + home; others only learn isVisiting", async () => {
		const s = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		expect((await app.inject({ method: "GET", url: "/v1/visiting/settings", headers: h(s) })).json()).toEqual({ setting: "AUTO" });
		// Sign-in reported a location: AUTO learned it as home already.
		const learned = (await app.inject({ method: "GET", url: "/v1/visiting/home", headers: h(s) })).json();
		expect(Math.abs(learned.lat - decodeGeohash("u33dc0").lat)).toBeLessThan(0.01);
		const home = { lat: 52.52, lon: 13.4 };
		expect((await app.inject({ method: "PUT", url: "/v1/visiting/home", headers: h(s), payload: home })).json()).toEqual({ name: "", lat: 52.52, lon: 13.4 });
		expect((await app.inject({ method: "GET", url: "/v1/visiting/home", headers: h(s) })).json()).toMatchObject({ lat: 52.52, lon: 13.4 });
		// 300 km from home with AUTO → visiting.
		await app.inject({ method: "PUT", url: "/v4/location", headers: h(s), payload: { geohash: encodeGeohash(destination(home, 300_000, 3)) } });
		const seen = (await app.inject({ method: "GET", url: `/v7/profiles/${s.profileId}`, headers: h(viewer) })).json().profiles[0];
		expect(seen.isVisiting).toBe(true);
		expect(JSON.stringify(seen)).not.toContain("52.52");
		await app.inject({ method: "PUT", url: "/v1/visiting/settings", headers: h(s), payload: { setting: "OFF" } });
		expect((await app.inject({ method: "GET", url: `/v7/profiles/${s.profileId}`, headers: h(viewer) })).json().profiles[0].isVisiting).toBe(false);
		expect(decodeGeohash("u33d").lat).toBeGreaterThan(50);
	});

	test("visiting AUTO without a set home: learned home, visiting far away, home moves after a long stay", async () => {
		const s = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		const start = decodeGeohash("u33dc0");
		const isVisiting = async () => (await app.inject({ method: "GET", url: `/v7/profiles/${s.profileId}`, headers: h(viewer) })).json().profiles[0].isVisiting as boolean;
		expect(await isVisiting()).toBe(false);
		// 300 km away from the learned home → visiting; the grid says so too.
		const away = destination(start, 300_000, 1.2);
		await app.inject({ method: "PUT", url: "/v4/location", headers: h(s), payload: { geohash: encodeGeohash(away) } });
		expect(await isVisiting()).toBe(true);
		const grid = (await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${encodeGeohash(away)}&pageNumber=1`, headers: h(viewer) })).json().items as { data: { profileId: number; isVisiting: boolean } }[];
		expect(grid.find((i) => String(i.data.profileId) === s.profileId)?.data.isVisiting).toBe(true);
		// ON / OFF override AUTO.
		await app.inject({ method: "PUT", url: "/v1/visiting/settings", headers: h(s), payload: { setting: "OFF" } });
		expect(await isVisiting()).toBe(false);
		await app.inject({ method: "PUT", url: "/v1/visiting/settings", headers: h(s), payload: { setting: "AUTO" } });
		expect(await isVisiting()).toBe(true);
	});

	test("visiting decision: learned home relocates after the stay, a chosen home never does", () => {
		const cfg = { radiusM: 50_000, relocateMs: 30 * 86_400_000 };
		const home = { lat: 52.52, lon: 13.4 };
		const munich = { lat: 48.14, lon: 11.58 };
		const day = 86_400_000;
		const t0 = Date.UTC(2026, 0, 1);
		const base = { mode: "AUTO" as const, home, homeAuto: true, awayAnchor: null, awaySince: null, location: munich, isVisiting: false };
		const first = decide(base, t0, cfg);
		expect(first).toMatchObject({ isVisiting: true, home });
		const stayed = decide({ ...base, awayAnchor: first.awayAnchor, awaySince: first.awaySince }, t0 + 31 * day, cfg);
		expect(stayed).toMatchObject({ isVisiting: false, home: munich, awayAnchor: null });
		const chosen = decide({ ...base, homeAuto: false, awayAnchor: first.awayAnchor, awaySince: first.awaySince }, t0 + 365 * day, cfg);
		expect(chosen).toMatchObject({ isVisiting: true, home });
		// No location ever: no home, not visiting.
		expect(decide({ ...base, home: null, location: null }, t0, cfg)).toMatchObject({ isVisiting: false, home: null });
	});
});

describe("forgot password", () => {
	test("mail with single-use link; reset changes the password and ends sessions", async () => {
		const s = await registerAndLogin(app);
		const unknown = await app.inject({ method: "POST", url: "/v3/users/forgot-password", headers: clientHeaders(), payload: { email: `nobody-${randomUUID()}@example.com` } });
		expect(unknown.statusCode).toBe(200);
		expect((await app.inject({ method: "POST", url: "/v3/users/forgot-password", headers: clientHeaders(), payload: { email: s.email } })).statusCode).toBe(200);

		// Mail arrives in Mailpit (docker compose), read via its API.
		let link: string | null = null;
		for (let i = 0; i < 75 && !link; i++) {
			await Bun.sleep(200);
			const search = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${s.email}`)}`).then((r) => r.json()) as { messages?: { ID: string }[] };
			const id = search.messages?.[0]?.ID;
			if (!id) continue;
			const msg = await fetch(`http://localhost:8025/api/v1/message/${id}`).then((r) => r.json()) as { Text: string };
			link = /\/reset-password\?token=([\w-]+)/.exec(msg.Text)?.[1] ?? null;
		}
		expect(link).not.toBeNull();

		const form = await app.inject({ method: "GET", url: `/reset-password?token=${link}` });
		expect(form.statusCode).toBe(200);
		expect(form.headers["content-security-policy"]).toContain("default-src 'none'");
		const mismatch = await app.inject({ method: "POST", url: "/reset-password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${link}&password=new-password-123&confirm=other` });
		expect(mismatch.statusCode).toBe(400);
		const ok = await app.inject({ method: "POST", url: "/reset-password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${link}&password=new-password-123&confirm=new-password-123` });
		expect(ok.statusCode).toBe(200);
		// Single use.
		expect((await app.inject({ method: "POST", url: "/reset-password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${link}&password=x-password-123&confirm=x-password-123` })).statusCode).toBe(410);

		// Old session ended; old password refused, new one works.
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).statusCode).toBe(401);
		const old = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: s.deviceId }), payload: { email: s.email, password: s.password, token: null, geohash: null } });
		expect(old.json().code).toBe(4);
		const fresh = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: s.deviceId }), payload: { email: s.email, password: "new-password-123", token: null, geohash: null } });
		expect(fresh.statusCode).toBe(200);
	}, 20_000);

	test("SMTP password is write-only in the admin API", async () => {
		await admin("PUT", "/admin/api/settings/smtp.password", { value: "s3cret" });
		const settings = (await admin("GET", "/admin/api/settings")).json().settings;
		expect(settings["smtp.password"]).toEqual({ value: "", default: "", isSet: true });
		await admin("PUT", "/admin/api/settings/smtp.password", { value: "" });
	});
});

describe("reports in the admin", () => {
	test("a report shows up as open; moderator resolves it; audit", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const h = clientHeaders({ deviceId: a.deviceId, token: a.sessionId });
		await app.inject({ method: "POST", url: `/v3.1/flags/${b.profileId}`, headers: h, payload: { reason: "SPAM", comment: "Werbung", locations: ["CHAT_MESSAGE"] } });
		const list = (await admin("GET", `/admin/api/reports?status=PENDING&profileId=${b.profileId}`)).json();
		expect(list.reports).toHaveLength(1);
		expect(list.reports[0]).toMatchObject({ reporterId: a.profileId, profileId: b.profileId, reason: "SPAM", comment: "Werbung", status: "PENDING", openForProfile: 1 });
		expect(list.counts.pending).toBeGreaterThanOrEqual(1);
		expect((await admin("PATCH", `/admin/api/reports/${list.reports[0].id}`, { status: "RESOLVED" })).statusCode).toBe(200);
		expect((await admin("GET", `/admin/api/reports?status=PENDING&profileId=${b.profileId}`)).json().reports).toHaveLength(0);
		const audit = (await admin("GET", "/admin/api/audit?limit=5")).json().entries as { action: string }[];
		expect(audit.some((e) => e.action === "report.status")).toBe(true);
	});
});

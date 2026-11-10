/**
 * Parsers for the official client's identity headers
 * (docs/content/grindr-api/security-headers.md). Each returns null when the
 * header is missing or malformed; the securityHeaders plugin decides what to
 * do with that.
 */

export const SUBSCRIPTION_TIERS = [
	"Free",
	"Plus",
	"Xtra",
	"Unlimited",
	"Premium",
	"Free_Plus",
	"Free_Xtra",
	"Free_Unlimited",
	"Free_Premium",
] as const;

export type UserAgentInfo = {
	appVersion: string;
	buildNumber: string;
	tier: string;
	os: string;
	deviceModel: string;
	manufacturer: string;
	platform: "android" | "ios" | "other";
};

const UA_RE = /^grindr3\/(\d+(?:\.\d+){1,3});(\d+);([A-Za-z_]+);([^;]+);([^;]+);([^;]+)$/;

export function parseUserAgent(value: string | undefined): UserAgentInfo | null {
	if (!value) return null;
	const m = UA_RE.exec(value.trim());
	if (!m) return null;
	const [, appVersion, buildNumber, tier, os, deviceModel, manufacturer] = m as unknown as string[];
	if (!(SUBSCRIPTION_TIERS as readonly string[]).includes(tier!)) return null;
	const platform = /^android/i.test(os!) ? "android" : /^ios/i.test(os!) ? "ios" : "other";
	return { appVersion: appVersion!, buildNumber: buildNumber!, tier: tier!, os: os!, deviceModel: deviceModel!, manufacturer: manufacturer!, platform };
}

export type DeviceInfo = {
	/** 16-hex androidId; also the `androidId` in device-key signatures. */
	deviceId: string;
	deviceType: 1 | 2;
	totalRam: number;
	screenResolution: string;
	advertisingId: string;
};

const DEVICE_RE =
	/^([0-9a-f]{16});GLOBAL;([12]);(\d{1,15});(\d{2,5}x\d{2,5});([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseDeviceInfo(value: string | undefined): DeviceInfo | null {
	if (!value) return null;
	const m = DEVICE_RE.exec(value.trim());
	if (!m) return null;
	return {
		deviceId: m[1]!.toLowerCase(),
		deviceType: Number(m[2]) as 1 | 2,
		totalRam: Number(m[3]),
		screenResolution: m[4]!,
		advertisingId: m[5]!.toLowerCase(),
	};
}

const LOCALE_RE = /^([a-z]{2,3})(?:_([A-Z]{2}|\d{3}))?$/;
const ACCEPT_LANGUAGE_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*(?:\s*,.*)?$/;
const TZ_RE = /^(?:[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+){0,2}|UTC|GMT)$/;

export function parseLocale(value: string | undefined): { language: string; region: string | null; tag: string } | null {
	if (!value) return null;
	const m = LOCALE_RE.exec(value.trim());
	if (!m) return null;
	return { language: m[1]!, region: m[2] ?? null, tag: m[2] ? `${m[1]}_${m[2]}` : m[1]! };
}

export function isValidAcceptLanguage(value: string | undefined): boolean {
	return !!value && ACCEPT_LANGUAGE_RE.test(value.trim());
}

export function isValidTimeZone(value: string | undefined): boolean {
	if (!value || !TZ_RE.test(value)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** `[FREE]`, `[FREE,XTRA]` … */
export function parseRolesHeader(value: string | undefined): string[] | null {
	if (!value) return null;
	const m = /^\[([A-Z_]+(?:,[A-Z_]+)*)?\]$/.exec(value.trim());
	if (!m) return null;
	return m[1] ? m[1].split(",") : [];
}

/** Compares dotted versions numerically; returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config";
import {
	type DeviceInfo,
	type UserAgentInfo,
	compareVersions,
	isValidAcceptLanguage,
	isValidTimeZone,
	parseDeviceInfo,
	parseLocale,
	parseRolesHeader,
	parseUserAgent,
} from "../lib/clientHeaders";
import { ApiError, accountBannedDecoy, errors } from "../lib/errors";
import { recordSecurityEvent } from "../lib/securityEvents";
import { getServerSetting } from "../modules/settings/settings";

export type ClientContext = {
	ua: UserAgentInfo;
	device: DeviceInfo;
	locale: { language: string; region: string | null; tag: string };
	timeZone: string;
	rolesHeader: string[] | null;
};

declare module "fastify" {
	interface FastifyRequest {
		client: ClientContext;
	}
	interface FastifyContextConfig {
		/** "app" (default): official-client headers required. "none": admin, media, health, jwks. */
		clientHeaders?: "app" | "none";
		/** Sign-in style routes answer header failures with the ACCOUNT_BANNED decoy, like upstream. */
		authRoute?: boolean;
	}
}

const FALLBACK_CLIENT: ClientContext = {
	ua: { appVersion: "0", buildNumber: "0", tier: "Free", os: "unknown", deviceModel: "unknown", manufacturer: "unknown", platform: "other" },
	device: { deviceId: "0000000000000000", deviceType: 2, totalRam: 0, screenResolution: "0x0", advertisingId: "00000000-0000-0000-0000-000000000000" },
	locale: { language: "en", region: "US", tag: "en_US" },
	timeZone: "UTC",
	rolesHeader: null,
};

function header(req: FastifyRequest, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

/**
 * Enforces the official client's identity headers exactly like the upstream
 * API (docs/content/grindr-api/security-headers.md):
 *  - User-Agent malformed → 400 urn:gr:err:header (WebSocket upgrade → 403)
 *  - L-Device-Info malformed → 403
 *  - Accept must be application/json (except /v3/bootstrap)
 *  - L-Time-Zone / L-Locale / Accept-Language must be present and well-formed
 * Sign-in routes answer every header failure with the ACCOUNT_BANNED decoy.
 */
export const securityHeadersPlugin = fp(async (app: FastifyInstance) => {
	app.decorateRequest("client", null as unknown as ClientContext);

	app.addHook("onRequest", async (req) => {
		const mode = req.routeOptions.config?.clientHeaders ?? "app";
		if (mode === "none") {
			req.client = FALLBACK_CLIENT;
			return;
		}
		const isWs = (header(req, "upgrade") ?? "").toLowerCase() === "websocket";
		const fail = async (status: 400 | 403, reason: string): Promise<never> => {
			await recordSecurityEvent("header_rejected", { ip: req.ip, detail: { reason, path: req.url } });
			if (req.routeOptions.config?.authRoute) throw accountBannedDecoy();
			if (status === 403 || isWs) throw new ApiError(403, { code: 403, message: "Forbidden" });
			throw errors.header(reason);
		};

		const ua = parseUserAgent(header(req, "user-agent"));
		const device = parseDeviceInfo(header(req, "l-device-info"));
		const locale = parseLocale(header(req, "l-locale"));
		const timeZone = header(req, "l-time-zone");
		const rolesHeader = parseRolesHeader(header(req, "l-grindr-roles"));

		if (!config.enforceSecurityHeaders) {
			req.client = {
				ua: ua ?? FALLBACK_CLIENT.ua,
				device: device ?? FALLBACK_CLIENT.device,
				locale: locale ?? FALLBACK_CLIENT.locale,
				timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC",
				rolesHeader,
			};
			return;
		}

		if (!ua) return fail(400, "user-agent");
		if (!device) return fail(403, "l-device-info");
		if (!isWs) {
			const accept = header(req, "accept");
			const isBootstrap = req.routeOptions.url === "/v3/bootstrap";
			if (!isBootstrap && !(accept ?? "").includes("application/json")) return fail(400, "accept");
		}
		if (!locale) return fail(400, "l-locale");
		if (!isValidAcceptLanguage(header(req, "accept-language"))) return fail(400, "accept-language");
		if (!isValidTimeZone(timeZone)) return fail(400, "l-time-zone");
		if (header(req, "l-grindr-roles") != null && rolesHeader == null) return fail(400, "l-grindr-roles");

		const minVersion = await getServerSetting<string>("client.minAppVersion");
		if (minVersion && compareVersions(ua.appVersion, minVersion) < 0) {
			// DeprecatedClientVersionError (authentication.md): HTTP 412, code 8.
			throw new ApiError(412, { code: 8, message: "The client version is deprecated" });
		}

		req.client = { ua, device, locale, timeZone: timeZone!, rolesHeader };
	});
});

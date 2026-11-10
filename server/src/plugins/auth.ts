import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config";
import { errors, problem } from "../lib/errors";
import { type SessionClaims, deviceBindingHash, verifySessionJwt } from "../lib/jwt";
import { recordSecurityEvent } from "../lib/securityEvents";
import { getTokenVersion } from "../modules/auth/sessions";

export type AuthContext = {
	userId: bigint;
	profileId: string;
	claims: SessionClaims;
	features: ReadonlySet<string>;
	featureFlags: ReadonlySet<string>;
};

declare module "fastify" {
	interface FastifyRequest {
		auth: AuthContext;
	}
	interface FastifyInstance {
		/** preHandler: requires a valid `Authorization: Grindr3 <jwt>`. */
		authenticate: (req: FastifyRequest) => Promise<void>;
	}
}

export function extractBearer(value: string | string[] | undefined): string | null {
	const v = Array.isArray(value) ? value[0] : value;
	if (!v) return null;
	const m = /^Grindr3\s+(\S+)$/.exec(v.trim());
	return m ? m[1]! : null;
}

/**
 * Verifies the session JWT and the bindings our server adds on top of the
 * upstream token: device (`did` vs L-Device-Info) and `tv` vs the user's
 * current token_version (admin revocation, role/flag changes, bans).
 * Any failure → 401, which makes the client refresh via its authToken.
 */
export async function authenticateRequest(req: FastifyRequest, token: string | null): Promise<AuthContext> {
	if (!token) throw errors.unauthorized();
	const claims = await verifySessionJwt(token);
	if (!claims) throw errors.unauthorized();
	if (config.enforceDeviceBinding && claims.did !== deviceBindingHash(req.client.device.deviceId)) {
		await recordSecurityEvent("device_mismatch", { userId: claims.profileId, deviceId: req.client.device.deviceId, ip: req.ip });
		throw errors.unauthorized();
	}
	const tv = await getTokenVersion(claims.profileId);
	if (tv !== claims.tv) throw errors.unauthorized();
	return {
		userId: BigInt(claims.profileId),
		profileId: claims.profileId,
		claims,
		features: new Set(claims.features),
		featureFlags: new Set(claims.featureFlags),
	};
}

export const authPlugin = fp(async (app: FastifyInstance) => {
	app.decorateRequest("auth", null as unknown as AuthContext);
	app.decorate("authenticate", async (req: FastifyRequest) => {
		req.auth = await authenticateRequest(req, extractBearer(req.headers.authorization));
		// Banned accounts keep a token (the client shows the ban screen from its
		// claims) but may not use the API beyond what the ban flow needs.
		if (req.auth.claims.restriction === "TIMED_BAN" && !req.routeOptions.config?.allowRestricted) {
			throw errors.forbidden("account restricted");
		}
		// Required e-mail verification: only the account-state routes stay open.
		const cfg = req.routeOptions.config;
		if (req.auth.featureFlags.has("email_verification_required") && !cfg?.allowUnverified && !cfg?.allowRestricted) {
			throw problem(403, "email_verification_required");
		}
	});
});

declare module "fastify" {
	interface FastifyContextConfig {
		/** Route stays usable while the account is restricted (ban agreement, legal). */
		allowRestricted?: boolean;
	}
}

/**
 * Errors in the shapes the official API uses, so the client's existing error
 * handling (src/hooks/useApi.ts, grindr-patched/src/rest.rs parse_api_error)
 * works unchanged.
 *
 * Two families exist upstream:
 *  - RFC-7807 problem bodies: `{ type: "urn:gr:err:<reason>", title, status, detail?, traceId }`
 *  - legacy coded bodies: `{ code, message, profileId, ... }` (sign-in, profile uploads)
 */

export type ProblemReason =
	| "bad_request"
	| "parameter"
	| "header"
	| "client_action"
	| "internal_error"
	| "resource_not_found"
	| "unauthorized_action"
	| "hit_banned_terms"
	| "banned_image"
	| "banned_video"
	| "entitlement_limit"
	| "tiered_feature"
	| "email_verification_required"
	| "rate_limited";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: Record<string, unknown>,
		readonly headers: Record<string, string> = {},
	) {
		super(typeof body.title === "string" ? body.title : typeof body.message === "string" ? body.message : `HTTP ${status}`);
	}
}

const DEFAULT_TITLES: Partial<Record<ProblemReason, string>> = {
	entitlement_limit: "User has reached their entitlement limits",
	tiered_feature: "Feature not available for the subscription tier",
	resource_not_found: "Resource not found",
	unauthorized_action: "Unauthorized action",
	rate_limited: "Too many requests",
};

export function problem(status: number, reason: ProblemReason, detail?: string, extra: Record<string, unknown> = {}): ApiError {
	return new ApiError(status, {
		type: `urn:gr:err:${reason}`,
		title: DEFAULT_TITLES[reason] ?? reason.replace(/_/g, " "),
		status,
		...(detail ? { detail } : {}),
		...extra,
	});
}

/** Legacy coded error body, e.g. `{"code":28,"message":"ACCOUNT_BANNED",...}`. */
export function coded(status: number, code: number, message: string, extra: Record<string, unknown> = {}): ApiError {
	return new ApiError(status, { code, message, ...extra });
}

/**
 * The upstream answer to a malformed/unauthenticated sign-in request. The
 * official API returns this fake ban for header problems too, so we do the
 * same and leak nothing about which check failed.
 */
export function accountBannedDecoy(): ApiError {
	return coded(403, 28, "ACCOUNT_BANNED", {
		profileId: null,
		type: 1,
		reason: null,
		isBanAutomated: true,
		thirdPartyUserIdToShow: null,
		banSubReason: null,
	});
}

export const errors = {
	notFound: () => problem(404, "resource_not_found"),
	unauthorized: () => new ApiError(401, { code: 401, message: "Unauthorized" }),
	forbidden: (detail?: string) => problem(403, "unauthorized_action", detail),
	badRequest: (detail?: string) => problem(400, "bad_request", detail),
	parameter: (detail?: string) => problem(400, "parameter", detail),
	header: (detail?: string) => problem(400, "header", detail),
	clientAction: (detail?: string) => problem(400, "client_action", detail),
	conflict: (detail?: string) => problem(409, "internal_error", detail),
	entitlementLimit: (key: string) => problem(402, "entitlement_limit", undefined, { entitlement: key }),
	tieredFeature: (key: string) => problem(402, "tiered_feature", undefined, { entitlement: key }),
	// Code 4 is what src/contexts/AuthContext.tsx (INVALID_INPUT_PARAMETERS_CODE)
	// matches. Not 401: the Rust client treats 401 as "refresh and retry".
	invalidCredentials: () => coded(400, 4, "INVALID_INPUT_PARAMETERS"),
	verificationRequired: (profileId: string | null) =>
		coded(403, 30, "Verification required", {
			profileId,
			type: null,
			reason: null,
			isBanAutomated: null,
			thirdPartyUserIdToShow: null,
			banSubReason: null,
		}),
};

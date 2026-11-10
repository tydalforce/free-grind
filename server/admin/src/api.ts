/** Thin client for /admin/api. Mutations send the CSRF header the server requires. */
export class AdminApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: { error?: string; detail?: string; [k: string]: unknown },
	) {
		super(body.detail ?? body.error ?? `HTTP ${status}`);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/admin/api${path}`, {
		method,
		credentials: "same-origin",
		headers: {
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...(method !== "GET" ? { "x-admin-request": "1" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	const data = text ? JSON.parse(text) : {};
	if (!res.ok) {
		if (res.status === 401 && path !== "/login" && path !== "/me") window.dispatchEvent(new Event("admin:unauthorized"));
		throw new AdminApiError(res.status, data);
	}
	return data as T;
}

export const api = {
	get: <T>(path: string) => request<T>("GET", path),
	post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
	put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
	patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
	del: <T>(path: string) => request<T>("DELETE", path),
};

// --- Shared types ------------------------------------------------------------

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

export type EntitlementDef = {
	key: string;
	type: "boolean" | "cap" | "duration" | "quota" | "list";
	group: string;
	unit?: "count" | "bytes" | "ms" | "seconds" | "meters";
	description: string;
	default: EntitlementValue;
	feature?: string;
	options?: string[];
};

export type Me = { username: string; role: "owner" | "moderator"; totpEnabled: boolean };

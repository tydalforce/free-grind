import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";

/** Headers exactly as grindr-patched/src/headers.rs builds them. */
/** Each simulated client gets its own IP (as seen through the reverse proxy). */
export function randomIp(): string {
	const b = randomBytes(3);
	return `10.${b[0]}.${b[1]}.${b[2]}`;
}

export function clientHeaders(opts: { deviceId?: string; token?: string; roles?: string; ip?: string } = {}): Record<string, string> {
	const deviceId = opts.deviceId ?? randomBytes(8).toString("hex");
	const h: Record<string, string> = {
		"x-forwarded-for": opts.ip ?? randomIp(),
		"l-time-zone": "Europe/Berlin",
		"l-device-info": `${deviceId};GLOBAL;2;8026152960;2400x1080;${randomUUID()}`,
		accept: "application/json",
		"user-agent": "grindr3/26.22.0.192710;192710;Free;Android 14;Pixel 8;Google",
		"l-locale": "de_DE",
		"accept-language": "de-DE",
		"accept-encoding": "gzip",
	};
	if (opts.token) {
		h.authorization = `Grindr3 ${opts.token}`;
		h["l-grindr-roles"] = opts.roles ?? "[FREE]";
	}
	return h;
}

export function newDeviceId(): string {
	return randomBytes(8).toString("hex");
}

export function uniqueEmail(): string {
	return `test-${randomUUID()}@example.com`;
}

export const ADULT_BIRTHDAY = Date.UTC(1995, 4, 17);

export async function registerAndLogin(app: FastifyInstance, deviceId = newDeviceId()) {
	const email = uniqueEmail();
	const password = "correct-horse-battery";
	const reg = await app.inject({
		method: "POST",
		url: "/v8/users",
		headers: clientHeaders({ deviceId }),
		payload: { email, password, birthday: ADULT_BIRTHDAY, captchaToken: "", token: "", optIn: false, sessionId: null },
	});
	if (reg.statusCode !== 200) throw new Error(`register failed ${reg.statusCode} ${reg.body}`);
	const login = await app.inject({
		method: "POST",
		url: "/v8/sessions",
		headers: clientHeaders({ deviceId }),
		payload: { email, password, token: null, geohash: "u33dc0" },
	});
	if (login.statusCode !== 200) throw new Error(`login failed ${login.statusCode} ${login.body}`);
	const session = login.json() as { profileId: string; sessionId: string; authToken: string };
	return { email, password, deviceId, ...session };
}

export function decodeJwt(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

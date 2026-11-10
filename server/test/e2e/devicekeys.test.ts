import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { buildApp } from "../../src/app";
import { clientHeaders, registerAndLogin } from "../helpers";

let app: FastifyInstance;

beforeAll(async () => {
	app = await buildApp();
});

afterAll(async () => {
	await app.close();
});

/** Mirrors grindr-patched/src/signing.rs DeviceKey. */
function newDeviceKey() {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const spki = publicKey.export({ format: "der", type: "spki" });
	const pub = spki.toString("base64url");
	const keyId = createHash("sha256").update(spki).digest("base64url");
	const signDer = (message: string) => sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
	return { pub, keyId, signDer };
}

async function registerKey(s: Awaited<ReturnType<typeof registerAndLogin>>) {
	const headers = clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
	const ch = await app.inject({ method: "POST", url: "/v1/verification/device-keys/challenge", headers, payload: {} });
	expect(ch.statusCode).toBe(200);
	const { challenge, expiresAt } = ch.json();
	expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
	const key = newDeviceKey();
	const registrationSignature = key.signDer(`${s.profileId}|${key.keyId}|${key.pub}|${s.deviceId}|${challenge}`);
	const res = await app.inject({
		method: "POST",
		url: "/v1/verification/device-keys",
		headers,
		payload: { publicKey: key.pub, keyId: key.keyId, registrationSignature },
	});
	return { res, key, headers, challenge };
}

function signedUpload(
	s: Awaited<ReturnType<typeof registerAndLogin>>,
	key: ReturnType<typeof newDeviceKey>,
	body: Buffer,
	opts: { timestamp?: number; nonce?: string; tamper?: boolean } = {},
) {
	const timestamp = String(opts.timestamp ?? Date.now());
	const nonce = opts.nonce ?? randomBytes(32).toString("base64url");
	const bodyHash = createHash("sha256").update(body).digest("base64url");
	const sig = key.signDer(`${bodyHash}|${timestamp}|${s.profileId}|${s.deviceId}|${nonce}`);
	return app.inject({
		method: "POST",
		url: "/__test/signed-upload",
		headers: {
			...clientHeaders({ deviceId: s.deviceId, token: s.sessionId }),
			"content-type": "image/jpeg",
			"x-key-id": key.keyId,
			"x-sig": sig,
			"x-timestamp": timestamp,
			"x-nonce": nonce,
		},
		payload: opts.tamper ? Buffer.concat([body, Buffer.from([0])]) : body,
	});
}

describe("device keys", () => {
	test("challenge → register echoes keyId; challenge is single-use", async () => {
		const s = await registerAndLogin(app);
		const { res, key, headers, challenge } = await registerKey(s);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ keyId: key.keyId });

		const again = await app.inject({
			method: "POST",
			url: "/v1/verification/device-keys",
			headers,
			payload: { publicKey: key.pub, keyId: key.keyId, registrationSignature: key.signDer(`${s.profileId}|${key.keyId}|${key.pub}|${s.deviceId}|${challenge}`) },
		});
		expect(again.statusCode).toBe(400);
	});

	test("wrong registration signature is rejected", async () => {
		const s = await registerAndLogin(app);
		const headers = clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
		await app.inject({ method: "POST", url: "/v1/verification/device-keys/challenge", headers, payload: {} });
		const key = newDeviceKey();
		const res = await app.inject({
			method: "POST",
			url: "/v1/verification/device-keys",
			headers,
			payload: { publicKey: key.pub, keyId: key.keyId, registrationSignature: key.signDer("something else") },
		});
		expect(res.statusCode).toBe(400);
	});

	test("signed upload: valid, tampered body, drift, replayed nonce, unknown key", async () => {
		const s = await registerAndLogin(app);
		const { key } = await registerKey(s);
		const body = randomBytes(2048);

		const ok = await signedUpload(s, key, body);
		expect(ok.statusCode).toBe(200);
		expect(ok.json()).toEqual({ signed: true });

		const tampered = await signedUpload(s, key, body, { tamper: true });
		expect(tampered.statusCode).toBe(400);
		expect(tampered.json().type).toContain("bad_signature");

		const drift = await signedUpload(s, key, body, { timestamp: Date.now() - 3_600_000 });
		expect(drift.json().type).toContain("timestamp_drift");
		expect(Number.isNaN(Date.parse(drift.json().detail))).toBe(false);

		const nonce = randomBytes(32).toString("base64url");
		expect((await signedUpload(s, key, body, { nonce })).statusCode).toBe(200);
		expect((await signedUpload(s, key, body, { nonce })).json().type).toContain("nonce_replayed");

		const unknown = await signedUpload(s, newDeviceKey(), body);
		expect(unknown.json().type).toContain("resource_not_found");
	});
});

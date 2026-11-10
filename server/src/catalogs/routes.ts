import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { localeChain } from "../lib/locale";
import { getServerSetting } from "../modules/settings/settings";
import { loadCatalog, serializeGenders, serializePronouns, serializeTags, etagOf } from "./service";

async function chainFor(req: FastifyRequest): Promise<string[]> {
	const def = ((await getServerSetting<string>("locale.default")) || "en").split("_")[0]!;
	const accept = req.headers["accept-language"];
	return localeChain(req.client.locale, Array.isArray(accept) ? accept[0] : accept, def);
}

/** Sends `body` with locale/caching headers; answers 304 when the client already has it. */
function sendCached(req: FastifyRequest, reply: FastifyReply, body: unknown, language: string | null) {
	const etag = etagOf(body);
	reply.header("etag", etag).header("vary", "L-Locale, Accept-Language").header("cache-control", "private, max-age=300");
	if (language) reply.header("content-language", language.replace("_", "-"));
	if (req.headers["if-none-match"] === etag) return reply.code(304).send();
	return reply.send(body);
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
	const genders = async (req: FastifyRequest, reply: FastifyReply) => {
		const chain = await chainFor(req);
		return sendCached(req, reply, serializeGenders(await loadCatalog(), chain), chain[0] ?? null);
	};
	// Public upstream (sign-up needs them before a session exists).
	app.get("/public/v2/genders", genders);
	app.get("/public/v1/genders", genders);

	app.get("/v1/pronouns", { preHandler: app.authenticate }, async (req, reply) => {
		const chain = await chainFor(req);
		return sendCached(req, reply, serializePronouns(await loadCatalog(), chain), chain[0] ?? null);
	});

	/** All languages at once (upstream shape); the client picks the closest. */
	app.get("/v1/tags", { preHandler: app.authenticate }, async (req, reply) => {
		const def = ((await getServerSetting<string>("locale.default")) || "en").split("_")[0]!;
		return sendCached(req, reply, serializeTags(await loadCatalog(), def), null);
	});
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Video processing via ffmpeg/ffprobe (installed in the worker image, see
 * server/Dockerfile). Output: H.264/AAC MP4 with faststart (progressive
 * playback), metadata stripped, plus a JPEG poster frame.
 */

export type ProbeResult = { durationMs: number; width: number; height: number; hasVideo: boolean };

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	return { code, stdout, stderr };
}

export async function ffmpegAvailable(): Promise<boolean> {
	try {
		const [a, b] = await Promise.all([run(["ffmpeg", "-version"], 5000), run(["ffprobe", "-version"], 5000)]);
		return a.code === 0 && b.code === 0;
	} catch {
		return false;
	}
}

export async function probe(path: string): Promise<ProbeResult> {
	const r = await run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], 30_000);
	if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.slice(0, 300)}`);
	const json = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
	const video = json.streams?.find((s) => s.codec_type === "video");
	return {
		durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
		width: video?.width ?? 0,
		height: video?.height ?? 0,
		hasVideo: !!video,
	};
}

export type TranscodeResult = { mp4: Buffer; poster: Buffer; probe: ProbeResult };

/** Transcodes `input` to a web-safe MP4 (max 1280 px long edge) and grabs a poster at ~10 %. */
export async function transcode(input: Uint8Array, opts: { maxDurationMs?: number; muteAudio?: boolean } = {}): Promise<TranscodeResult> {
	const dir = await mkdtemp(join(tmpdir(), "fgvid-"));
	try {
		const src = join(dir, "in");
		const out = join(dir, "out.mp4");
		const poster = join(dir, "poster.jpg");
		await writeFile(src, input);
		const info = await probe(src);
		if (!info.hasVideo) throw new Error("no video stream");
		const limit = opts.maxDurationMs && Number.isFinite(opts.maxDurationMs) ? ["-t", String(opts.maxDurationMs / 1000)] : [];
		const audio = opts.muteAudio ? ["-an"] : ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];
		const t = await run(
			[
				"ffmpeg", "-y", "-v", "error", "-i", src, ...limit,
				"-map_metadata", "-1", "-map", "0:v:0", ...(opts.muteAudio ? [] : ["-map", "0:a:0?"]),
				"-vf", "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
				"-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-profile:v", "high",
				...audio, "-movflags", "+faststart", out,
			],
			10 * 60_000,
		);
		if (t.code !== 0) throw new Error(`ffmpeg failed: ${t.stderr.slice(0, 300)}`);
		const at = Math.max(0, Math.min(info.durationMs * 0.1, 3000)) / 1000;
		const p = await run(["ffmpeg", "-y", "-v", "error", "-ss", String(at), "-i", out, "-frames:v", "1", "-q:v", "3", poster], 60_000);
		if (p.code !== 0) throw new Error(`poster failed: ${p.stderr.slice(0, 300)}`);
		const outProbe = await probe(out);
		return { mp4: await readFile(out), poster: await readFile(poster), probe: outProbe };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Magic-byte sniffing: we never trust the client's Content-Type alone. MP4 and
 * WebM can hold audio only (voice messages from MediaRecorder), so for those
 * the track types decide; the declared type only breaks a tie when the
 * container doesn't reveal its tracks.
 */
export function sniffKind(buf: Uint8Array, declaredMime?: string | null): "image" | "video" | "audio" | null {
	if (buf.length < 12) return null;
	const ascii = (from: number, len: number) => String.fromCharCode(...buf.subarray(from, from + len));
	const declaredAudio = !!declaredMime && declaredMime.trim().toLowerCase().startsWith("audio/");
	if (buf[0] === 0xff && buf[1] === 0xd8) return "image"; // JPEG
	if (ascii(1, 3) === "PNG") return "image";
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image";
	if (ascii(0, 3) === "GIF") return "image";
	if (ascii(4, 4) === "ftyp") {
		const brand = ascii(8, 4);
		if (["heic", "heix", "mif1", "msf1", "avif"].includes(brand)) return "image";
		if (brand.startsWith("M4A")) return "audio";
		const tracks = mp4HandlerTypes(buf);
		if (tracks.has("vide")) return "video";
		if (tracks.has("soun")) return "audio";
		return declaredAudio ? "audio" : "video"; // isom, mp41, mp42, qt, 3gp…
	}
	if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
		// Matroska/WebM: CodecID strings "V_…" / "A_…" tell the track kinds.
		const codecs = matroskaCodecKinds(buf);
		if (codecs.has("V")) return "video";
		if (codecs.has("A")) return "audio";
		return declaredAudio ? "audio" : "video";
	}
	if (ascii(0, 4) === "OggS" || ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return "audio";
	return null;
}

const SCAN_LIMIT = 2 * 1024 * 1024;

/** Handler types of the `hdlr` boxes (`vide`, `soun`, …) in the first bytes of an MP4. */
function mp4HandlerTypes(buf: Uint8Array): Set<string> {
	const out = new Set<string>();
	const end = Math.min(buf.length, SCAN_LIMIT) - 16;
	for (let i = 4; i < end; i++) {
		// "hdlr" + version/flags (4) + pre_defined (4) + handler_type (4)
		if (buf[i] === 0x68 && buf[i + 1] === 0x64 && buf[i + 2] === 0x6c && buf[i + 3] === 0x72) {
			out.add(String.fromCharCode(buf[i + 12]!, buf[i + 13]!, buf[i + 14]!, buf[i + 15]!));
		}
	}
	return out;
}

/** "V"/"A" for every CodecID element (0x86, one-byte size) in the first bytes of a Matroska file. */
function matroskaCodecKinds(buf: Uint8Array): Set<string> {
	const out = new Set<string>();
	const end = Math.min(buf.length, SCAN_LIMIT) - 4;
	for (let i = 0; i < end; i++) {
		if (buf[i] !== 0x86 || (buf[i + 1]! & 0x80) === 0) continue;
		const kind = buf[i + 2];
		if ((kind === 0x56 || kind === 0x41) && buf[i + 3] === 0x5f) out.add(String.fromCharCode(kind));
	}
	return out;
}

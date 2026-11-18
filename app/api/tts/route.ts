/**
 * One read-aloud segment as WAV. The renderer posts a sentence (verbatim)
 * or a formatted block (describe, Realtime models only) with the chosen
 * provider, model, and voice. Synthesis and the disk cache live in
 * src/server/tts.ts.
 */
import { DEFAULT_TTS_CHOICE, isTtsChoice } from "@/src/core";
import { isTtsMode, synthesizeSpeech, TTS_MAX_CHARS, TtsError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: { text?: unknown; mode?: unknown; choice?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ message: "Expected a JSON body" }, { status: 400 });
	}
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text || text.length > TTS_MAX_CHARS || !isTtsMode(body.mode)) {
		return Response.json({ message: `Expected text (1-${TTS_MAX_CHARS} chars) and mode "verbatim" or "describe"` }, { status: 400 });
	}
	if (body.choice !== undefined && !isTtsChoice(body.choice)) {
		return Response.json({ message: "Unknown TTS provider, model, or voice" }, { status: 400 });
	}
	try {
		const wav = await synthesizeSpeech(text, body.mode, body.choice ?? DEFAULT_TTS_CHOICE);
		return new Response(new Uint8Array(wav), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
	} catch (error) {
		const status = error instanceof TtsError ? error.status : 502;
		const setup = error instanceof TtsError ? error.setup : undefined;
		return Response.json({ message: error instanceof Error ? error.message : "Speech synthesis failed", setup }, { status });
	}
}

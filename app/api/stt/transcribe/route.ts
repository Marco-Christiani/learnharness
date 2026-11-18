/**
 * POST one recorded dictation run (audio/wav) and get its transcript.
 * Serves the OpenAI dictation engines; src/server/stt.ts picks the
 * account from saved settings.
 */
import { STT_MAX_BYTES, SttError, transcribeDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const wav = new Uint8Array(await request.arrayBuffer());
	if (wav.length <= 44) return Response.json({ message: "Expected a WAV recording" }, { status: 400 });
	if (wav.length > STT_MAX_BYTES) return Response.json({ message: "Recording is over the 25 MB transcription limit" }, { status: 413 });
	try {
		return Response.json({ text: await transcribeDictation(wav) });
	} catch (error) {
		if (error instanceof SttError) return Response.json({ message: error.message, setup: error.setup }, { status: error.status });
		return Response.json({ message: error instanceof Error ? error.message : "Transcription failed" }, { status: 502 });
	}
}

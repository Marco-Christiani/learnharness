import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalWav, geminiRequestBody, geminiWav, RealtimeAudioCollector, realtimeRequestEvent, TtsError, ttsCacheKey, wavFromPcm16 } from "../src/server/tts.ts";
import { DEFAULT_TTS_CHOICE, isTtsChoice, settleTtsChoice, ttsDescribesBlocks } from "../src/core/read-aloud.ts";

describe("tts server", () => {
	it("wraps PCM16 in a mono 24 kHz WAV header", () => {
		const wav = wavFromPcm16(Buffer.alloc(480));
		assert.equal(wav.length, 524);
		assert.equal(wav.toString("ascii", 0, 4), "RIFF");
		assert.equal(wav.readUInt32LE(24), 24_000);
		assert.equal(wav.readUInt32LE(40), 480);
	});

	it("keys the cache by text, mode, model, and voice", () => {
		const c = DEFAULT_TTS_CHOICE;
		assert.equal(ttsCacheKey("Hi.", "verbatim", c), ttsCacheKey("Hi.", "verbatim", { ...c }));
		assert.notEqual(ttsCacheKey("Hi.", "verbatim", c), ttsCacheKey("Hi.", "describe", c));
		assert.notEqual(ttsCacheKey("Hi.", "verbatim", c), ttsCacheKey("Hi.", "verbatim", { ...c, voice: "cedar" }));
	});

	it("validates and settles voice choices", () => {
		assert.ok(isTtsChoice(DEFAULT_TTS_CHOICE));
		assert.ok(!isTtsChoice({ provider: "openai", model: "tts-1", voice: "marin" }));
		assert.deepEqual(settleTtsChoice({ provider: "gemini", model: "gpt-realtime-2.1-mini", voice: "marin" }), { provider: "gemini", model: "gemini-3.8-flash-tts", voice: "Kore" });
		assert.deepEqual(settleTtsChoice({ provider: "openai", model: "tts-1", voice: "marin" }), { provider: "openai", model: "tts-1", voice: "alloy" });
		assert.ok(ttsDescribesBlocks("gpt-realtime-2.1-mini"));
		assert.ok(!ttsDescribesBlocks("gemini-3.8-flash-tts"));
	});

	it("normalizes WAVs with extra chunks and reads Gemini audio", () => {
		const pcm = Buffer.from([1, 0, 2, 0]);
		const plain = wavFromPcm16(pcm, 16_000);
		const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
		const odd = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
		assert.deepEqual(canonicalWav(odd), plain);
		const fromPcm = geminiWav({ steps: [{ type: "model_output", content: [{ type: "audio", data: pcm.toString("base64"), mime_type: "audio/L16;rate=24000" }] }] });
		assert.equal(fromPcm.readUInt32LE(24), 24_000);
		assert.deepEqual(fromPcm.subarray(44), pcm);
		assert.equal(geminiWav({ steps: [{ type: "model_output", content: [{ type: "audio", data: plain.toString("base64") }] }] }).readUInt32LE(24), 16_000);
		assert.throws(() => geminiWav({ steps: [] }), TtsError);
		assert.deepEqual((geminiRequestBody("Hi.", { provider: "gemini", model: "gemini-3.8-flash-tts", voice: "Kore" }) as { generation_config: unknown }).generation_config, { speech_config: [{ voice: "Kore" }] });
	});

	it("requests audio-only output outside the conversation", () => {
		const event = realtimeRequestEvent("Hi.", "verbatim") as { response: Record<string, unknown> };
		assert.equal(event.response.conversation, "none");
		assert.deepEqual(event.response.output_modalities, ["audio"]);
	});

	it("collects audio deltas until the response completes", () => {
		const collector = new RealtimeAudioCollector();
		assert.equal(collector.accept({ type: "response.output_audio.delta", delta: Buffer.from([1, 2]).toString("base64") }), null);
		assert.equal(collector.accept({ type: "response.output_audio.delta", delta: Buffer.from([3, 4]).toString("base64") }), null);
		assert.deepEqual([...collector.accept({ type: "response.done", response: { status: "completed" } })!], [1, 2, 3, 4]);
	});

	it("maps API errors to statuses", () => {
		const collector = new RealtimeAudioCollector();
		assert.throws(() => collector.accept({ type: "error", error: { code: "invalid_api_key", message: "bad" } }), (e: unknown) => e instanceof TtsError && e.status === 401);
		assert.throws(() => new RealtimeAudioCollector().accept({ type: "response.done", response: { status: "failed" } }), TtsError);
	});
});

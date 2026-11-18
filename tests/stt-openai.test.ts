import assert from "node:assert/strict";
import { test } from "node:test";
import { openAiTranscriptionLanguage, sanitizeUserSettings } from "../src/core/index.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { transcriptionRequest } from "../src/server/stt.ts";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";
import { pcm16Wav } from "../components/dictation.tsx";

const wav = new Uint8Array(48);

test("the API-key engine posts gpt-transcribe with the base language code", () => {
	const req = transcriptionRequest("openai-api", wav, { apiKey: "k" }, "en-US");
	assert.equal(req.url, "https://api.openai.com/v1/audio/transcriptions");
	assert.equal(req.headers.Authorization, "Bearer k");
	assert.equal(req.body.get("model"), "gpt-transcribe");
	assert.equal(req.body.get("language"), "en");
	assert.equal((req.body.get("file") as File).name, "audio.wav");
	assert.equal(transcriptionRequest("openai-api", wav, { apiKey: "k" }, "multi").body.get("language"), null);
});

test("the ChatGPT engine posts only the file with the account header", () => {
	const req = transcriptionRequest("openai-chatgpt", wav, { accessToken: "t", accountId: "acct" }, "fr");
	assert.equal(req.url, "https://chatgpt.com/backend-api/transcribe");
	assert.deepEqual(req.headers, { Authorization: "Bearer t", "ChatGPT-Account-Id": "acct" });
	assert.deepEqual([...req.body.keys()], ["file"]);
});

test("language codes map to ISO-639-1", () => {
	assert.equal(openAiTranscriptionLanguage("zh-Hant"), "zh");
	assert.equal(openAiTranscriptionLanguage("pt-BR"), "pt");
	assert.equal(openAiTranscriptionLanguage("multi"), undefined);
});

test("settings keep each valid dictation field independently", () => {
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { language: "nope", engine: "openai-api" } })?.dictation, { engine: "openai-api" });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { language: "fr", engine: "nope" } })?.dictation, { language: "fr" });
	assert.deepEqual(parseDictationSettingsBody({ language: "en", engine: "openai-chatgpt" }), { ok: true, settings: { language: "en", engine: "openai-chatgpt" } });
	assert.equal(parseDictationSettingsBody({ engine: "whisper" }).ok, false);
});

test("saving either field writes the whole dictation section", async () => {
	const bodies: unknown[] = [];
	const store = createDictationLanguageStore(async (_url, init) => {
		if (init?.method === "PUT") {
			bodies.push(JSON.parse(init.body as string));
			return Response.json({ settings: { version: 1, dictation: JSON.parse(init.body as string) } });
		}
		return Response.json({ settings: { version: 1, dictation: { language: "fr" } } });
	});
	assert.equal(await store.getEngine(), "deepgram");
	assert.equal(await store.saveEngine("openai-api"), true);
	assert.equal(await store.save("de"), true);
	assert.deepEqual(bodies, [{ language: "fr", engine: "openai-api" }, { language: "de", engine: "openai-api" }]);
	assert.equal(await store.getEngine(), "openai-api");
});

test("recorded frames become a 16 kHz mono WAV", async () => {
	const blob = pcm16Wav([new ArrayBuffer(320), new ArrayBuffer(160)]);
	const bytes = new DataView(await blob.arrayBuffer());
	assert.equal(blob.size, 44 + 480);
	assert.equal(bytes.getUint32(24, true), 16_000);
	assert.equal(bytes.getUint32(40, true), 480);
});

/**
 * One-shot dictation transcription for the OpenAI engines. The renderer
 * records the whole run and posts it here as WAV when dictation stops.
 * The engine and language come from saved settings, never the request.
 * Deepgram does not come through here: it streams from the renderer with
 * a token from /api/stt/token.
 */
import { chatGPTConnected, chatGPTLease, chatGPTModels, chatGPTScope } from "../agent/chatgpt-bridge.ts";
import { openAiTranscriptionLanguage, type DictationEngine, type DictationLanguage } from "../core/dictation.ts";
import { keyValue } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings } from "./stores.ts";

export const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
/** OpenAI's upload limit is 25 MB. */
export const STT_MAX_BYTES = 25 * 1024 * 1024;
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
// NOTE(chatgpt-stt): undocumented ChatGPT backend route, the same request Codex CLI sends for voice input
const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

/** `setup` names what the selected engine is missing, for the renderer's deep link. */
export class SttError extends Error {
	constructor(readonly status: number, message: string, readonly setup?: "openai-key" | "chatgpt-signin") {
		super(message);
	}
}

/** The multipart body and headers for one transcription request. Pure, for tests. */
export function transcriptionRequest(
	engine: Exclude<DictationEngine, "deepgram">,
	wav: Uint8Array,
	auth: { apiKey?: string; accessToken?: string; accountId?: string },
	language: DictationLanguage,
): { url: string; headers: Record<string, string>; body: FormData } {
	const body = new FormData();
	body.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
	if (engine === "openai-api") {
		body.append("model", OPENAI_TRANSCRIBE_MODEL);
		const code = openAiTranscriptionLanguage(language);
		if (code) body.append("language", code);
		return { url: OPENAI_TRANSCRIBE_URL, headers: { Authorization: `Bearer ${auth.apiKey}` }, body };
	}
	// the ChatGPT route takes only the file and detects the language itself
	const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}` };
	if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
	return { url: CHATGPT_TRANSCRIBE_URL, headers, body };
}

async function chatGPTCredentials(): Promise<{ accessToken: string; accountId: string }> {
	if (!chatGPTConnected()) throw new SttError(503, "Dictation is set to ChatGPT sign-in. Connect ChatGPT under Settings > Keys > Subscriptions.", "chatgpt-signin");
	if (chatGPTModels().length === 0) await refreshConnectionCatalog("chatgpt");
	const model = chatGPTModels()[0];
	if (!model) throw new SttError(503, "The ChatGPT account's model list is unavailable. Try again shortly.", "chatgpt-signin");
	// a lease is scoped to a catalog model; transcription uses none, so any listed model scopes it
	const lease = await chatGPTLease(chatGPTScope(model.id), false);
	return { accessToken: lease.accessToken, accountId: lease.accountId };
}

/** The transcript of one recorded dictation run. */
export async function transcribeDictation(wav: Uint8Array): Promise<string> {
	const { engine, language } = effectiveSettings().dictation;
	if (engine === "deepgram") throw new SttError(400, "Deepgram dictation streams from the app and does not use this route.");
	let auth: { apiKey?: string; accessToken?: string; accountId?: string };
	if (engine === "openai-api") {
		const apiKey = keyValue("OPENAI_API_KEY");
		if (!apiKey) throw new SttError(503, "Dictation is set to OpenAI (API key). Add an OpenAI key under Settings > Keys > Model API keys.", "openai-key");
		auth = { apiKey };
	} else {
		try {
			auth = await chatGPTCredentials();
		} catch (error) {
			if (error instanceof SttError) throw error;
			throw new SttError(503, error instanceof Error ? error.message : "ChatGPT sign-in is unavailable", "chatgpt-signin");
		}
	}
	const request = transcriptionRequest(engine, wav, auth, language);
	let res: Response;
	try {
		res = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
	} catch {
		throw new SttError(502, "The transcription service is unreachable");
	}
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 300);
		throw new SttError(502, `Transcription failed (${res.status}): ${detail}`);
	}
	const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
	if (!data || typeof data.text !== "string") throw new SttError(502, "Transcription returned no text");
	return data.text.trim();
}

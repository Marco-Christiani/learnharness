/**
 * The read-aloud voice catalog shared by the player and the TTS route.
 * A choice is a provider, one of its models, and a voice that model offers.
 */

export type TtsProvider = "openai" | "gemini";
/** How a model is called: OpenAI Realtime, OpenAI's Speech API, or Gemini TTS. */
export type TtsBackend = "realtime" | "speech" | "gemini";

export interface TtsChoice {
	provider: TtsProvider;
	model: string;
	voice: string;
}

export interface TtsModelInfo {
	id: string;
	provider: TtsProvider;
	backend: TtsBackend;
	voices: readonly string[];
	/** Shown under the model picker, such as a shutdown date. */
	notice?: string;
}

export const TTS_PROVIDER_LABELS: Record<TtsProvider, string> = { openai: "OpenAI", gemini: "Gemini" };
export const TTS_PROVIDER_KEYS: Record<TtsProvider, string> = { openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

const REALTIME_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
const SPEECH_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const LEGACY_SPEECH_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const GEMINI_VOICES = [
	"Kore", "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe", "Charon",
	"Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Laomedeia", "Leda", "Orus", "Puck",
	"Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel", "Vindemiatrix",
	"Zephyr", "Zubenelgenubi",
];
const SPEECH_SHUTDOWN = "OpenAI shuts this model down on 2027-01-06.";

export const TTS_MODELS: readonly TtsModelInfo[] = [
	{ id: "gpt-realtime-2.1-mini", provider: "openai", backend: "realtime", voices: REALTIME_VOICES },
	{ id: "gpt-4o-mini-tts", provider: "openai", backend: "speech", voices: SPEECH_VOICES, notice: SPEECH_SHUTDOWN },
	{ id: "tts-1", provider: "openai", backend: "speech", voices: LEGACY_SPEECH_VOICES, notice: SPEECH_SHUTDOWN },
	{ id: "tts-1-hd", provider: "openai", backend: "speech", voices: LEGACY_SPEECH_VOICES, notice: SPEECH_SHUTDOWN },
	{ id: "gemini-3.8-flash-tts", provider: "gemini", backend: "gemini", voices: GEMINI_VOICES },
	{ id: "gemini-3.8-flash-lite-tts", provider: "gemini", backend: "gemini", voices: GEMINI_VOICES },
];

export const DEFAULT_TTS_CHOICE: TtsChoice = { provider: "openai", model: "gpt-realtime-2.1-mini", voice: "marin" };

export function ttsModel(id: string): TtsModelInfo | undefined {
	return TTS_MODELS.find((model) => model.id === id);
}

export function ttsModelsFor(provider: TtsProvider): TtsModelInfo[] {
	return TTS_MODELS.filter((model) => model.provider === provider);
}

export function isTtsChoice(value: unknown): value is TtsChoice {
	if (value === null || typeof value !== "object") return false;
	const { provider, model, voice } = value as Record<string, unknown>;
	const info = typeof model === "string" ? ttsModel(model) : undefined;
	return !!info && info.provider === provider && typeof voice === "string" && info.voices.includes(voice);
}

/**
 * The nearest valid choice after one field changes: a new provider takes
 * its first model, and a voice the model lacks falls back to its first.
 */
export function settleTtsChoice(choice: Partial<TtsChoice>): TtsChoice {
	const provider = choice.provider === "gemini" ? "gemini" : "openai";
	const models = ttsModelsFor(provider);
	const model = models.find((m) => m.id === choice.model) ?? models[0]!;
	const voice = choice.voice && model.voices.includes(choice.voice) ? choice.voice : model.voices[0]!;
	return { provider, model: model.id, voice };
}

/** Only Realtime models are language models that can voice a description of a formatted block. */
export function ttsDescribesBlocks(model: string): boolean {
	return ttsModel(model)?.backend === "realtime";
}

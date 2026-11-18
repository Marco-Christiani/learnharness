"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_TTS_CHOICE, isTtsChoice, settleTtsChoice, ttsDescribesBlocks, type TtsChoice } from "@/src/core";
import { runRange, segmentRange, type BlockKind, type ReadSegment } from "./segments";
import { PassageTimeline, wavDurationMs, wordAt } from "./timing";

/**
 * The single read-aloud playback controller. Segments are fetched one at a
 * time from /api/tts (cached on the server) with two segments prefetched
 * ahead, played through one audio element, and followed in the transcript
 * with CSS custom highlights: the whole segment, plus an estimated word for
 * verbatim prose.
 */

export type ReadAloudStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface ReadAloudState {
	status: ReadAloudStatus;
	/** The message id the read started from. */
	key: string | null;
	index: number;
	count: number;
	positionMs: number;
	totalMs: number;
	/** True while some segment durations are still estimates. */
	estimated: boolean;
	error: string | null;
	/** The provider, model, and voice new audio is generated with. */
	choice: TtsChoice;
}

interface Clip {
	url: string;
	durationMs: number;
}

const IDLE: ReadAloudState = { status: "idle", key: null, index: 0, count: 0, positionMs: 0, totalMs: 0, estimated: false, error: null, choice: DEFAULT_TTS_CHOICE };
const CHOICE_STORAGE_KEY = "lh.readAloud.choice";
/** Spoken in place of a formatted block by models that cannot describe one. */
const SKIPPED: Record<BlockKind, string> = { code: "Code block skipped.", table: "Table skipped.", math: "Formula skipped." };

function storedChoice(): TtsChoice {
	try {
		const raw = JSON.parse(globalThis.localStorage?.getItem(CHOICE_STORAGE_KEY) ?? "null") as unknown;
		return isTtsChoice(raw) ? raw : DEFAULT_TTS_CHOICE;
	} catch {
		return DEFAULT_TTS_CHOICE;
	}
}
const PREFETCH = 2;
// the word highlight runs slightly ahead so it lands as the word is heard
const WORD_LEAD_MS = 300;
const SENTENCE_HIGHLIGHT = "lh-read-sentence";
const WORD_HIGHLIGHT = "lh-read-word";

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlights(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
	const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
	const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
	return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null;
}

class ReadAloudPlayer {
	private state: ReadAloudState = IDLE;
	private listeners = new Set<() => void>();
	private segments: ReadSegment[] = [];
	private timeline = new PassageTimeline([]);
	private clips = new Map<number, Promise<Clip>>();
	private urls: string[] = [];
	private audio: HTMLAudioElement | null = null;
	private loaded = -1;
	private token = 0;
	private frame = 0;
	private sentenceRange: Range | null = null;
	/** True after the last segment plays out; the bar stays for a replay. */
	private ended = false;
	private choiceLoaded = false;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	snapshot = () => {
		if (!this.choiceLoaded && typeof window !== "undefined") {
			this.choiceLoaded = true;
			this.state = { ...this.state, choice: storedChoice() };
		}
		return this.state;
	};

	/** Switches provider, model, or voice; an active read restarts its current segment with the new voice. */
	setChoice(patch: Partial<TtsChoice>) {
		const choice = settleTtsChoice({ ...this.snapshot().choice, ...patch });
		try { localStorage.setItem(CHOICE_STORAGE_KEY, JSON.stringify(choice)); } catch { /* per-device convenience only */ }
		this.set({ choice });
		if (this.segments.length === 0) return;
		const resume = this.state.status === "playing" || this.state.status === "loading";
		for (const url of this.urls) URL.revokeObjectURL(url);
		this.urls = [];
		this.clips.clear();
		this.loaded = -1;
		this.timeline = new PassageTimeline(this.segments.map((s) => s.text.length));
		this.set({ totalMs: this.timeline.totalMs, estimated: true });
		void this.playAt(this.ended ? 0 : this.state.index, 0, resume);
	}

	private set(patch: Partial<ReadAloudState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	start(segments: ReadSegment[], key: string) {
		this.stop();
		if (segments.length === 0) return;
		this.segments = segments;
		this.timeline = new PassageTimeline(segments.map((s) => s.text.length));
		this.set({ ...IDLE, choice: this.snapshot().choice, key, count: segments.length, totalMs: this.timeline.totalMs, estimated: true });
		void this.playAt(0, 0, true);
	}

	stop() {
		this.token++;
		cancelAnimationFrame(this.frame);
		this.audio?.pause();
		this.audio?.removeAttribute("src");
		this.loaded = -1;
		for (const url of this.urls) URL.revokeObjectURL(url);
		this.urls = [];
		this.clips.clear();
		this.segments = [];
		this.sentenceRange = null;
		this.ended = false;
		const h = highlights();
		h?.registry.delete(SENTENCE_HIGHLIGHT);
		h?.registry.delete(WORD_HIGHLIGHT);
		if (this.state.status !== "idle") this.set({ ...IDLE, choice: this.state.choice });
	}

	toggle() {
		if (this.state.status === "playing") this.pause();
		else if (this.state.status === "paused" || this.state.status === "error") this.resume();
	}

	pause() {
		if (this.state.status !== "playing" && this.state.status !== "loading") return;
		this.audio?.pause();
		cancelAnimationFrame(this.frame);
		this.set({ status: "paused" });
	}

	resume() {
		if (this.ended) {
			void this.playAt(0, 0, true);
			return;
		}
		if (this.audio && this.loaded === this.state.index && this.state.status === "paused") {
			void this.audio.play().then(() => { this.set({ status: "playing" }); this.tick(); }).catch(() => {});
			return;
		}
		void this.playAt(this.state.index, 0, true);
	}

	next() {
		if (this.state.index + 1 < this.segments.length) void this.playAt(this.state.index + 1, 0, this.state.status !== "paused");
	}

	prev() {
		// past the first two seconds, "previous" restarts the current segment
		const into = this.audio && this.loaded === this.state.index ? this.audio.currentTime : 0;
		const target = into > 2 ? this.state.index : Math.max(this.state.index - 1, 0);
		void this.playAt(target, 0, this.state.status !== "paused");
	}

	seek(positionMs: number) {
		if (this.segments.length === 0) return;
		const { index, offsetMs } = this.timeline.locate(positionMs);
		const autoplay = this.state.status !== "paused";
		this.ended = false;
		if (this.audio && index === this.loaded) {
			this.audio.currentTime = offsetMs / 1000;
			this.set({ index, positionMs: this.timeline.startOf(index) + offsetMs });
			this.paint(true);
			return;
		}
		void this.playAt(index, offsetMs, autoplay);
	}

	/** Jumps to the segment containing a DOM point, when one does. */
	jumpToPoint(node: Node, offset: number): boolean {
		const index = this.segments.findIndex((segment) => {
			try { return segmentRange(segment)?.isPointInRange(node, offset) ?? false; } catch { return false; }
		});
		if (index < 0) return false;
		void this.playAt(index, 0, true);
		return true;
	}

	private clip(index: number): Promise<Clip> {
		let clip = this.clips.get(index);
		if (clip) return clip;
		const segment = this.segments[index]!;
		const timeline = this.timeline;
		const choice = this.state.choice;
		const skipped = segment.mode === "describe" && !ttsDescribesBlocks(choice.model);
		const request = skipped ? { text: SKIPPED[segment.kind], mode: "verbatim" } : { text: segment.text, mode: segment.mode };
		clip = fetch("/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...request, choice }),
		}).then(async (res) => {
			if (!res.ok) {
				const body = await res.json().catch(() => null) as { message?: string } | null;
				throw new Error(body?.message ?? `Read aloud failed (${res.status})`);
			}
			const blob = await res.blob();
			const rate = new DataView(await blob.slice(24, 28).arrayBuffer()).getUint32(0, true);
			const durationMs = wavDurationMs(blob.size, rate || 24_000);
			timeline.record(index, durationMs);
			if (timeline === this.timeline) this.set({ totalMs: timeline.totalMs, estimated: this.segments.some((_, i) => !timeline.isKnown(i)) });
			const url = URL.createObjectURL(blob);
			this.urls.push(url);
			return { url, durationMs };
		});
		clip.catch(() => { if (this.clips.get(index) === clip) this.clips.delete(index); });
		this.clips.set(index, clip);
		return clip;
	}

	/** The end of the passage: paused at the end with highlights cleared, clips kept for a replay. */
	private finish() {
		cancelAnimationFrame(this.frame);
		this.ended = true;
		this.sentenceRange = null;
		const h = highlights();
		h?.registry.delete(SENTENCE_HIGHLIGHT);
		h?.registry.delete(WORD_HIGHLIGHT);
		this.set({ status: "paused", positionMs: this.timeline.totalMs });
	}

	private async playAt(index: number, offsetMs: number, autoplay: boolean) {
		const token = ++this.token;
		this.ended = false;
		cancelAnimationFrame(this.frame);
		this.audio?.pause();
		this.set({ status: "loading", index, error: null, positionMs: this.timeline.startOf(index) + offsetMs });
		this.paint(true);
		let clip: Clip;
		try {
			clip = await this.clip(index);
		} catch (error) {
			if (token === this.token) this.set({ status: "error", error: error instanceof Error ? error.message : "Read aloud failed" });
			return;
		}
		if (token !== this.token) return;
		// prefetch after the current clip so the first segment is never queued behind others
		for (let i = index + 1; i <= index + PREFETCH && i < this.segments.length; i++) this.clip(i).catch(() => {});
		const audio = this.ensureAudio();
		audio.src = clip.url;
		this.loaded = index;
		audio.currentTime = Math.min(offsetMs, clip.durationMs) / 1000;
		if (!autoplay) {
			this.set({ status: "paused" });
			this.paint(true);
			return;
		}
		try {
			await audio.play();
		} catch {
			if (token === this.token) this.set({ status: "paused" });
			return;
		}
		if (token !== this.token) return;
		this.set({ status: "playing" });
		this.tick();
	}

	private ensureAudio(): HTMLAudioElement {
		if (this.audio) return this.audio;
		const audio = new Audio();
		audio.preload = "auto";
		audio.addEventListener("ended", () => {
			if (this.state.status !== "playing") return;
			if (this.state.index + 1 < this.segments.length) void this.playAt(this.state.index + 1, 0, true);
			else this.finish();
		});
		this.audio = audio;
		return audio;
	}

	private tick = () => {
		cancelAnimationFrame(this.frame);
		if (this.state.status !== "playing") return;
		this.paint(false);
		this.frame = requestAnimationFrame(this.tick);
	};

	/** Updates position and highlights; `moved` re-resolves the segment highlight. */
	private paint(moved: boolean) {
		const index = this.state.index;
		const segment = this.segments[index];
		if (!segment) return;
		const h = highlights();
		if (moved || !this.sentenceRange) {
			this.sentenceRange = segmentRange(segment);
			if (h) {
				if (this.sentenceRange) h.registry.set(SENTENCE_HIGHLIGHT, new h.Highlight(this.sentenceRange));
				else h.registry.delete(SENTENCE_HIGHLIGHT);
			}
			if (moved) revealRange(this.sentenceRange);
		}
		const audio = this.audio;
		const current = audio && this.loaded === index ? audio.currentTime * 1000 : 0;
		if (!moved) this.set({ positionMs: this.timeline.startOf(index) + current });
		if (!h) return;
		if (segment.mode !== "verbatim" || this.loaded !== index || this.state.status !== "playing") {
			h.registry.delete(WORD_HIGHLIGHT);
			return;
		}
		const duration = this.timeline.durationOf(index);
		const rate = audio?.playbackRate ?? 1;
		const fraction = duration > 0 ? (current + WORD_LEAD_MS * rate) / duration : 0;
		const word = runRange(segment.run, wordAt(segment.run.text, segment.span, fraction));
		if (word) h.registry.set(WORD_HIGHLIGHT, new h.Highlight(word));
	}
}

function revealRange(range: Range | null) {
	if (!range) return;
	const rect = range.getBoundingClientRect();
	if (rect.height === 0 && rect.width === 0) return;
	const element = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
	// keep clear of the bottom dock, which covers roughly the lowest third of the window
	if (rect.top >= 64 && rect.bottom <= window.innerHeight * 0.66) return;
	element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export const readAloud = new ReadAloudPlayer();

export function useReadAloud(): ReadAloudState {
	return useSyncExternalStore(readAloud.subscribe, readAloud.snapshot, () => IDLE);
}

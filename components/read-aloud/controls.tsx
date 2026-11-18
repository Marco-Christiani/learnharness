"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Loader2, Pause, Play, Settings2, SkipBack, SkipForward, Square, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThinSelect } from "@/components/settings/controls";
import { TTS_PROVIDER_LABELS, ttsDescribesBlocks, ttsModel, ttsModelsFor, type TtsChoice, type TtsProvider } from "@/src/core";
import { SOURCE_ATTRIBUTE, sourceElements } from "@/components/selection-text";
import type { SelectionAction } from "@/components/selection-toolbar";
import { cn } from "@/lib/utils";
import { readAloud, useReadAloud } from "./player";
import { readSegments } from "./segments";

/** Marks the passage element a read-aloud button reads; the value is the read's key. */
export const READ_ALOUD_SCOPE = "data-read-aloud-scope";

/** Reads the one passage it sits in (the nearest READ_ALOUD_SCOPE element). */
export function ReadAloudButton({ scopeKey, className }: { scopeKey: string; className?: string }) {
	const state = useReadAloud();
	const ref = useRef<HTMLButtonElement>(null);
	const active = state.status !== "idle" && state.key === scopeKey;
	return (
		<Button
			ref={ref}
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={active ? "Stop reading aloud" : "Read aloud"}
			title={active ? "Stop reading aloud" : "Read aloud"}
			data-testid="read-aloud-button"
			className={cn("text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100", className, active && "opacity-100 text-foreground")}
			onClick={() => {
				if (active) { readAloud.stop(); return; }
				const scope = ref.current?.closest(`[${READ_ALOUD_SCOPE}]`);
				if (scope) readAloud.start(readSegments([scope]), scopeKey);
			}}
		>
			{active ? <Square /> : <Volume2 />}
		</Button>
	);
}

export function createReadAloudAction(viewport: () => Element | null): SelectionAction {
	return {
		id: "read-aloud",
		label: "Read aloud",
		ariaLabel: "Read the selection aloud",
		icon: Volume2,
		visible: () => true,
		onSelect: (capture) => {
			const root = viewport();
			if (!root) return false;
			const segments = readSegments(sourceElements(root, capture.messageId), capture.range);
			if (segments.length === 0) return false;
			readAloud.start(segments, capture.messageId);
			return true;
		},
	};
}

function formatTime(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Plain clicks on a sentence of the passage being read jump playback there. */
function useClickToJump(active: boolean) {
	useEffect(() => {
		if (!active) return;
		const onClick = (event: MouseEvent) => {
			if (event.button !== 0 || !document.getSelection()?.isCollapsed) return;
			const target = event.target as Element | null;
			if (!target?.closest(`[${SOURCE_ATTRIBUTE}]`) || target.closest("button, a, input, textarea")) return;
			const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
			const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
			if (caret) { readAloud.jumpToPoint(caret.offsetNode, caret.offset); return; }
			const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
			if (range) readAloud.jumpToPoint(range.startContainer, range.startOffset);
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [active]);
}

function VoiceSettings({ choice, onClose }: { choice: TtsChoice; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onPointerDown = (event: globalThis.PointerEvent) => {
			const target = event.target as Element | null;
			if (!ref.current?.contains(target) && !target?.closest("[data-read-aloud-settings-toggle]")) onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey, true);
		return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKey, true); };
	}, [onClose]);
	const info = ttsModel(choice.model);
	const row = "flex items-center justify-between gap-3";
	return (
		<div ref={ref} data-testid="read-aloud-settings" className="absolute bottom-full right-0 mb-2 flex w-72 flex-col gap-2 rounded-xl border border-border bg-card p-3 text-xs text-foreground shadow-xl">
			<label className={row}>Provider
				<ThinSelect value={choice.provider} ariaLabel="Read-aloud provider" testid="read-aloud-provider" onChange={(provider) => readAloud.setChoice({ provider: provider as TtsProvider })}>
					{(Object.keys(TTS_PROVIDER_LABELS) as TtsProvider[]).map((id) => <option key={id} value={id}>{TTS_PROVIDER_LABELS[id]}</option>)}
				</ThinSelect>
			</label>
			<label className={row}>Model
				<ThinSelect value={choice.model} ariaLabel="Read-aloud model" testid="read-aloud-model" onChange={(model) => readAloud.setChoice({ model })}>
					{ttsModelsFor(choice.provider).map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
				</ThinSelect>
			</label>
			<label className={row}>Voice
				<ThinSelect value={choice.voice} ariaLabel="Read-aloud voice" testid="read-aloud-voice" onChange={(voice) => readAloud.setChoice({ voice })}>
					{(info?.voices ?? []).map((voice) => <option key={voice} value={voice}>{voice}</option>)}
				</ThinSelect>
			</label>
			{info?.notice && <p className="text-[11px] text-muted-foreground">{info.notice}</p>}
			{!ttsDescribesBlocks(choice.model) && <p className="text-[11px] text-muted-foreground">This model skips code, tables, and display math, and says so in their place. Realtime models describe them.</p>}
		</div>
	);
}

/** The floating player shown above the composer while a read is active. */
export function ReadAloudBar({ className }: { className?: string }) {
	const state = useReadAloud();
	const active = state.status !== "idle";
	const [settingsOpen, setSettingsOpen] = useState(false);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	const [drag, setDrag] = useState<number | null>(null);
	useClickToJump(active);
	useEffect(() => { if (!active) setSettingsOpen(false); }, [active]);
	if (!active) return null;
	// dragging only previews the position; audio is fetched where the drag is released
	const fraction = drag ?? (state.totalMs > 0 ? Math.min(state.positionMs / state.totalMs, 1) : 0);
	const pointerFraction = (event: PointerEvent<HTMLDivElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
	};
	return (
		<div
			data-testid="read-aloud-bar"
			className={cn("pointer-events-auto relative flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 font-ui text-xs text-muted-foreground shadow-sm", className)}
		>
			<Button type="button" variant="ghost" size="icon-xs" aria-label="Previous sentence" onClick={() => readAloud.prev()}><SkipBack /></Button>
			<Button type="button" variant="ghost" size="icon-xs" aria-label={state.status === "playing" ? "Pause" : "Play"} onClick={() => readAloud.toggle()}>
				{state.status === "loading" ? <Loader2 className="animate-spin" /> : state.status === "playing" ? <Pause /> : <Play />}
			</Button>
			<Button type="button" variant="ghost" size="icon-xs" aria-label="Next sentence" disabled={state.index + 1 >= state.count} onClick={() => readAloud.next()}><SkipForward /></Button>
			{state.status === "error" ? (
				<span role="alert" className="mx-2 max-w-72 truncate text-destructive" title={state.error ?? undefined}>{state.error}</span>
			) : (
				<>
					<div
						role="slider"
						aria-label="Playback position"
						aria-valuemin={0}
						aria-valuemax={Math.round(state.totalMs / 1000)}
						aria-valuenow={Math.round(state.positionMs / 1000)}
						tabIndex={0}
						className="relative mx-2 h-4 w-40 cursor-pointer"
						onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag(pointerFraction(event)); }}
						onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setDrag(pointerFraction(event)); }}
						onPointerUp={(event) => { if (drag !== null) readAloud.seek(pointerFraction(event) * state.totalMs); setDrag(null); }}
						onPointerCancel={() => setDrag(null)}
						onKeyDown={(event) => {
							if (event.key === "ArrowRight") readAloud.seek(state.positionMs + 5000);
							else if (event.key === "ArrowLeft") readAloud.seek(state.positionMs - 5000);
						}}
					>
						<div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
						<div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/60" style={{ width: `${fraction * 100}%` }} />
						<div className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: `${fraction * 100}%` }} />
					</div>
					<span className="tabular-nums" title={state.estimated ? "Total length is estimated until every sentence has loaded" : undefined}>
						{formatTime(state.positionMs)} / {state.estimated ? "~" : ""}{formatTime(state.totalMs)}
					</span>
				</>
			)}
			<Button type="button" variant="ghost" size="icon-xs" aria-label="Voice settings" aria-expanded={settingsOpen} data-read-aloud-settings-toggle="" onClick={() => setSettingsOpen((open) => !open)}><Settings2 /></Button>
			<Button type="button" variant="ghost" size="icon-xs" aria-label="Stop reading aloud" onClick={() => readAloud.stop()}><X /></Button>
			{settingsOpen && <VoiceSettings choice={state.choice} onClose={closeSettings} />}
		</div>
	);
}

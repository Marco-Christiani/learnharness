"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { WaypointsIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { NotesImportReview } from "./notes-import-review";
import { IMPORT_ACCEPT } from "@/lib/notes-import-limits.ts";
import { useInteractionLayer, useInteractionLayers } from "@/components/interaction-layers";
import { HostDialog, INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { createNotesImportQueue, EMPTY_IMPORT_QUEUE, notesPath } from "./notes-import-queue";

export { MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
export { notesPath } from "./notes-import-queue";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	syncStatus?: "new" | "changed" | "unchanged" | "unverified";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

/** Validate every response row against its request index and full path. */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Check the graph before retrying.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== notesPath(files[r.requestIndex]!)) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider", "notice"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[], preview = false, requestId?: string, signal?: AbortSignal): Promise<NotesImportResult[]> {
	const form = new FormData();
	if (requestId) form.append("requestId", requestId);
	if (preview) form.append("preview", "true");
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	const response = await fetch("/api/graph/import", { method: "POST", body: form, signal });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
	const results = parseNotesImportResults(body, files);
	if (preview && results.some((result) => result.ok && !["new", "changed", "unchanged", "unverified"].includes(result.syncStatus ?? ""))) throw new Error("Invalid sync preview response.");
	return results;
}

// Client module singleton: shared by both home views and successive selections.
// SSR never appends Files, and uses the immutable empty server snapshot.
async function stopNotesImport(_path: string, requestId: string) {
	const response = await fetch("/api/graph/import", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) });
	if (!response.ok) throw new Error("Could not stop import. Try again.");
}
const pageImportQueue = createNotesImportQueue((files, requestId) => postNotesImport(files, false, requestId), stopNotesImport);

export function NotesImportProgress() {
	const snapshot = useSyncExternalStore(pageImportQueue.subscribe, pageImportQueue.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!snapshot.importing) return;
		const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [snapshot.importing]);
	if (!snapshot.rows.length) return null;
	return <div className="fixed bottom-4 left-4 z-50 rounded-lg border bg-card shadow-lg">
		<button className="p-2 text-xs" onClick={() => setOpen(!open)}>Sync progress ({snapshot.rows.filter((row) => row.status === "completed").length}/{snapshot.rows.length})</button>
		<HostDialog open={open} onClose={() => { setOpen(false); return "closed"; }} aria-label="Sync progress" backdropProps={{ className: "fixed inset-0 flex items-center justify-center bg-background/80" }} frame={<div className="max-h-[75vh] w-[min(90vw,48rem)] overflow-auto rounded border bg-card p-4 shadow-xl" />}>
			<div className="flex justify-between text-sm"><button onClick={() => snapshot.paused ? pageImportQueue.resume() : pageImportQueue.pause()}>{snapshot.paused ? "Resume queue" : "Pause queue"}</button><button onClick={() => setOpen(false)}>Close progress</button></div>
			<p className="py-2 text-xs text-muted-foreground">Pause holds pending files. Stop cancels an active extraction. Earlier merges remain saved.</p>
			{snapshot.rows.map((row) => <div key={row.index} className="flex items-start gap-2 border-t py-2 text-xs"><span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{row.path}</span><span>{row.status}</span>{(row.status === "pending" || row.status === "extracting") && <button onClick={() => void pageImportQueue.cancel(row.index)}>{row.status === "pending" ? "Cancel" : "Stop"}</button>}</div>)}
		</HostDialog>
	</div>;
}
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const snapshot = useSyncExternalStore(pageImportQueue.subscribe, pageImportQueue.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const latest = useRef(callbacks);
	latest.current = callbacks;
	const seenCompletion = useRef(snapshot.completion);
	useEffect(() => {
		if (seenCompletion.current !== snapshot.completion) {
			seenCompletion.current = snapshot.completion;
			latest.current.onFinish?.();
		}
	}, [snapshot.completion]);
	return {
		errors: snapshot.errors, notices: snapshot.notices, importing: snapshot.importing,
		onImportFiles: (files: FileList | readonly File[] | null) => {
			if (!files || files.length === 0) return;
			latest.current.onStart?.();
			pageImportQueue.append(Array.from(files));
		},
	};
}

/** Files and folders are reviewed before entering the extraction queue. */
export function NotesImportControl({ importing, onImportFiles }: { importing: boolean; onImportFiles: (files: FileList | readonly File[] | null) => void }) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [reviewFiles, setReviewFiles] = useState<File[]>([]);
	const hintId = useId();
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		setReviewFiles(Array.from(event.target.files ?? []));
		event.target.value = "";
	};
	const rootRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const interactions = useInteractionLayers();
	const popupLayer = useInteractionLayer({ kind: "popup", enabled: open, rootRef: panelRef, anchorRef: rootRef,
		onClose: () => { setOpen(false); return "closed"; } });
	const choices = [["Files", filesRef], ["Folder", folderRef]] as const;
	return (
		<>
		{reviewFiles.length > 0 && <NotesImportReview files={reviewFiles} onClose={() => setReviewFiles([])} onConfirm={onImportFiles} />}
		<div ref={rootRef} className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (interactions.isElementEligible(panelRef.current) && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
			<input ref={filesRef} type="file" multiple accept={IMPORT_ACCEPT} className="hidden" onChange={onChange} />
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<Hint label="Extract files into the graph" side="bottom">
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
					<WaypointsIcon className="size-3" />{importing ? "Extracting…" : "Sync files…"}
				</button>
			</Hint>
			{open && (
				<div ref={panelRef} role="menu" aria-label="Extract files into the graph" aria-describedby={hintId} style={{ zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }} className="absolute right-0 top-full mt-1 w-52 rounded-lg border bg-card p-1 shadow-lg">
					<div role="none"><p id={hintId} className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">For lessons, attach material to a session instead.</p></div>
					{choices.map(([label, input]) => <button key={label} type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
				</div>
			)}
		</div>
		</>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => <p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-error">{error}</p>)}</>;
}
export function NotesImportNotices({ notices }: { notices: readonly string[] }) {
	return <>{notices.map((notice, i) => <p key={i} role="status" className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice}</p>)}</>;
}

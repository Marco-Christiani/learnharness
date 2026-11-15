"use client";

import { useEffect, useRef, useState } from "react";
import { HostDialog } from "./host-dialog";
import { postNotesImport, type NotesImportResult } from "./notes-import";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import { notesPath, withNotesDestination } from "./notes-import-queue";

export { withNotesDestination } from "./notes-import-queue";

export function matchesNotesExclusion(path: string, patterns: string): boolean {
	return patterns.split(/[\n,]/).map((pattern) => pattern.trim()).filter(Boolean).some((pattern) => {
		const regex = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
		return new RegExp(regex, "i").test(path);
	});
}

export function NotesImportReview({ files, onClose, onConfirm }: {
	files: readonly File[]; onClose: () => void; onConfirm: (files: readonly File[]) => void;
}) {
	const previewController = useRef<AbortController | null>(null);
	useEffect(() => () => previewController.current?.abort(), []);
	const close = () => { previewController.current?.abort(); onClose(); };
	const [selected, setSelected] = useState(() => new Set(files.map((_, i) => i)));
	const [destination, setDestination] = useState("");
	const [exclusions, setExclusions] = useState("");
	const [results, setResults] = useState<Record<string, NotesImportResult>>({});
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState("");
	const paths = files.map((file) => [destination, notesPath(file)].filter(Boolean).join("/"));
	const duplicatePaths = new Set(paths.filter((path, index) => paths.indexOf(path) !== index));
	const rows = files.map((file, index) => {
		const path = [destination, notesPath(file)].filter(Boolean).join("/");
		const eligible = !duplicatePaths.has(path) && IMPORT_EXTENSIONS.test(file.name) && file.size <= MAX_IMPORT_BYTES && validNotesPath(path, file.name)
			&& !notesPath(file).split("/").slice(1).some((part) => part.startsWith("."));
		return { file, index, path, eligible, included: selected.has(index) && eligible && !matchesNotesExclusion(path, exclusions) };
	});
	const included = rows.filter((row) => row.included);
	const ready = included.every((row) => results[row.path]?.ok);
	const count = included.filter((row) => results[row.path]?.syncStatus !== "unchanged").length;
	async function check() {
		const controller = new AbortController();
		previewController.current = controller;
		setChecking(true); setError("");
		try {
			for (const row of included) {
				if (controller.signal.aborted) break;
				const [result] = await postNotesImport([withNotesDestination(row.file, destination)], true, undefined, controller.signal);
				setResults((previous) => ({ ...previous, [row.path]: result! }));
			}
		} catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
		finally { setChecking(false); }
	}
	return <HostDialog open onClose={() => { close(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 flex items-center justify-center bg-background/80" }} aria-label="Review files to sync"
		frame={<div className="flex max-h-[85vh] w-[min(90vw,56rem)] flex-col gap-3 rounded-xl border bg-card p-5 shadow-xl" />}>
		<h2 className="text-lg font-medium">Review files to sync</h2>
		<p className="text-sm text-muted-foreground">Check changes before syncing. Unchanged files skip extraction. Earlier imports need one extraction to establish a sync baseline.</p>
		<label className="text-sm">Destination folder<input disabled={checking} value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Course/Week" className="ml-2 rounded border p-1" /></label>
		<label className="text-sm">Exclude paths containing (comma separated, * matches any text)<input disabled={checking} value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="build/, *build-log*, node_modules/" className="mt-1 block w-full rounded border p-1" /></label>
		<div className="flex gap-3 text-sm"><button disabled={checking} onClick={() => setSelected(new Set(files.map((_, i) => i)))}>Select all</button><button disabled={checking} onClick={() => setSelected(new Set())}>Clear selection</button><span>{included.length} selected, {ready ? count : "unchecked"} need extraction</span></div>
		<div className="min-h-0 overflow-auto rounded border">
			{rows.map((row) => <label key={row.index} className="flex items-start gap-2 border-b p-2 text-sm">
				<input type="checkbox" disabled={checking || !row.eligible} checked={row.included} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(row.index)) next.delete(row.index); else next.add(row.index); return next; })} />
				<span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{row.path}</span>
				<span>{duplicatePaths.has(row.path) ? "Duplicate path. Select a folder or import separately." : !row.eligible ? "Unsupported" : !row.included ? "Excluded" : results[row.path]?.error ?? results[row.path]?.syncStatus ?? "Unchecked"}</span>
			</label>)}
		</div>
		{error && <p role="alert">{error}</p>}
		<div className="flex justify-end gap-3 text-sm">
			<button onClick={close}>Cancel</button>
			<button disabled={checking || !included.length} onClick={() => void check()}>{checking ? "Checking…" : "Check changes"}</button>
			<button disabled={checking || !ready || !included.length} onClick={() => { onConfirm(included.map((row) => withNotesDestination(row.file, destination))); onClose(); }}>Sync {included.length} {included.length === 1 ? "file" : "files"}</button>
		</div>
	</HostDialog>;
}

"use client";

import { useState } from "react";
import { HostDialog } from "./host-dialog";
import { postNotesImport, type NotesImportResult } from "./notes-import";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import { notesPath } from "./notes-import-queue";

export function withNotesDestination(file: File, destination: string): File {
	const copy = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
	Object.defineProperty(copy, "webkitRelativePath", { value: [destination, notesPath(file)].filter(Boolean).join("/") });
	return copy;
}

export function matchesNotesExclusion(path: string, patterns: string): boolean {
	return patterns.split(/[\n,]/).map((pattern) => pattern.trim()).filter(Boolean).some((pattern) => {
		const regex = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
		return new RegExp(regex, "i").test(path);
	});
}

export function NotesImportReview({ files, onClose, onConfirm }: {
	files: readonly File[]; onClose: () => void; onConfirm: (files: readonly File[]) => void;
}) {
	const [selected, setSelected] = useState(() => new Set(files.map((_, i) => i)));
	const [destination, setDestination] = useState("");
	const [exclusions, setExclusions] = useState("");
	const [results, setResults] = useState<Record<string, NotesImportResult>>({});
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState("");
	const rows = files.map((file, index) => {
		const path = [destination, notesPath(file)].filter(Boolean).join("/");
		const eligible = IMPORT_EXTENSIONS.test(file.name) && file.size <= MAX_IMPORT_BYTES && validNotesPath(path, file.name)
			&& !notesPath(file).split("/").slice(1).some((part) => part.startsWith("."));
		return { file, index, path, eligible, included: selected.has(index) && eligible && !matchesNotesExclusion(path, exclusions) };
	});
	const included = rows.filter((row) => row.included);
	const ready = included.every((row) => results[row.path]?.ok);
	const count = included.filter((row) => results[row.path]?.syncStatus !== "unchanged").length;
	async function check() {
		setChecking(true); setError("");
		try {
			for (const row of included) {
				const [result] = await postNotesImport([withNotesDestination(row.file, destination)], true);
				setResults((previous) => ({ ...previous, [row.path]: result! }));
			}
		} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setChecking(false); }
	}
	return <HostDialog open onClose={() => { if (checking) return "blocked"; onClose(); return "closed"; }} aria-label="Review files to sync"
		frame={<div className="flex max-h-[85vh] w-[min(90vw,56rem)] flex-col gap-3 rounded-xl border bg-card p-5 shadow-xl" />}>
		<h2 className="text-lg font-medium">Review files to sync</h2>
		<p className="text-sm text-muted-foreground">Check changes before syncing. Completed, unchanged files skip extraction. Files imported before fingerprints are available need one extraction to establish a baseline.</p>
		<label className="text-sm">Destination folder<input disabled={checking} value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Course/Week" className="ml-2 rounded border p-1" /></label>
		<label className="text-sm">Exclude paths containing (comma separated, * matches any text)<input disabled={checking} value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="build/, *build-log*, node_modules/" className="mt-1 block w-full rounded border p-1" /></label>
		<div className="flex gap-3 text-sm"><button disabled={checking} onClick={() => setSelected(new Set(files.map((_, i) => i)))}>Select all</button><button disabled={checking} onClick={() => setSelected(new Set())}>Clear selection</button><span>{included.length} selected</span></div>
		<div className="min-h-0 overflow-auto rounded border">
			{rows.map((row) => <label key={row.index} className="flex items-start gap-2 border-b p-2 text-sm">
				<input type="checkbox" disabled={checking || !row.eligible} checked={row.included} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(row.index)) next.delete(row.index); else next.add(row.index); return next; })} />
				<span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{row.path}</span>
				<span>{!row.eligible ? "Unsupported" : !row.included ? "Excluded" : results[row.path]?.error ?? results[row.path]?.syncStatus ?? "Unchecked"}</span>
			</label>)}
		</div>
		{error && <p role="alert">{error}</p>}
		<div className="flex justify-end gap-3 text-sm">
			<button disabled={checking} onClick={onClose}>Cancel</button>
			<button disabled={checking || !included.length} onClick={() => void check()}>{checking ? "Checking…" : "Check changes"}</button>
			<button disabled={checking || !ready || !count} onClick={() => { onConfirm(included.filter((row) => results[row.path]?.syncStatus !== "unchanged").map((row) => withNotesDestination(row.file, destination))); onClose(); }}>Sync {count} files</button>
		</div>
	</HostDialog>;
}

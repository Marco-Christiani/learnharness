import { notesImportLimitReached } from "@/src/core";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import type { NotesImportResult } from "./notes-import";

const selectionPaths = new WeakMap<File, string>();

export function withNotesDestination(file: File, destination: string): File {
	const copy = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
	Object.defineProperty(copy, "webkitRelativePath", { value: [destination, notesPath(file)].filter(Boolean).join("/") });
	selectionPaths.set(copy, selectionPaths.get(file) ?? file.webkitRelativePath ?? "");
	return copy;
}

export const notesPath = (file: File): string => file.webkitRelativePath || file.name;
/** Folder imports silently exclude dot-prefixed files and directories below
 * the chosen root. The root is segment 0 and stays importable even when hidden. */
const hiddenInFolder = (file: File): boolean => (selectionPaths.get(file) ?? file.webkitRelativePath).split("/").slice(1).some((part) => part.startsWith("."));
/** From the last dot of the file name, lower-cased. A dot that starts the name (".DS_Store") or ends it ("notes.") is not an extension. */
const extensionLabel = (name: string): string => {
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "no extension";
};
/** One line per reason for a whole pick, so a big folder cannot flood the error list. */
const unsupportedSummary = (extensions: readonly string[]): string =>
	`Skipped ${extensions.length} ${extensions.length === 1 ? "file that isn't" : "files that aren't"} text, Markdown, or PDF (${[...new Set(extensions)].join(", ")}).`;
const unsafeSummary = (count: number): string =>
	`Skipped ${count} ${count === 1 ? "file with a name" : "files with names"} the import can't use (e.g. a ':' in the name).`;
export interface ImportQueueRow { index: number; path: string; status: "pending" | "extracting" | "stopping" | "completed" | "failed" | "canceled"; }
export interface ImportQueueSnapshot {
	paused: boolean;
	rows: ImportQueueRow[];
	importing: boolean;
	errors: string[];
	notices: string[];
	completion: number;
}
export const EMPTY_IMPORT_QUEUE: ImportQueueSnapshot = { importing: false, errors: [], notices: [], completion: 0, paused: false, rows: [] };

/** Three workers share a pausable queue. Completed rows retain paths and status. */
export function createNotesImportQueue(post: (files: readonly File[], requestId?: string) => Promise<NotesImportResult[]>, stop?: (path: string, requestId: string) => Promise<void>) {
	const requestIds = new Map<number, string>();
	let paused = false;
	const rows = new Map<number, ImportQueueRow>();
	const listeners = new Set<() => void>();
	const pending: { file: File; index: number }[] = [];
	const failures = new Map<number, string>();
	const notices = new Map<number, string>();
	let active = 0, sequence = 0;
	let snapshot = EMPTY_IMPORT_QUEUE;
	const ordered = (map: Map<number, string>) => [...map].sort(([a], [b]) => a - b).map(([, text]) => text);
	const publish = (completed = false) => {
		snapshot = { paused, rows: [...rows.values()].map((row) => ({ ...row })), importing: active > 0 || pending.length > 0, errors: ordered(failures), notices: ordered(notices), completion: snapshot.completion + Number(completed) };
		for (const listener of [...listeners]) listener();
	};
	// Normalize a synchronously throwing transport to the same async settlement.
	const send = async (file: File, index: number) => post([file], requestIds.get(index));
	function pump(): void {
		while (!paused && active < 3 && pending.length > 0) {
			const { file, index } = pending.shift()!;
			rows.get(index)!.status = "extracting";
			active++;
			void (async () => {
				try {
					const [r] = await send(file, index);
					if (!r) throw new Error("Invalid import response. Check the graph before retrying.");
					rows.get(index)!.status = r.ok ? "completed" : r.outcome === "aborted" ? "canceled" : "failed";
					if (!r.ok) {
						if (r.code === "rate_limited" || notesImportLimitReached(r.error ?? "")) paused = true;
						const details = [r.provider, r.missing?.join(", "), r.slots?.join(", ")].filter(Boolean);
						failures.set(index, `${r.filePath}: ${r.error}${r.code ? `\n${[r.code, ...details].join(" — ")}` : ""}`);
					} else if (r.notice) notices.set(index, `${r.filePath}: ${r.notice}`);
				} catch (error) {
					rows.get(index)!.status = "failed";
					// Never retry an ambiguous response: the merge may have committed.
					failures.set(index, `${notesPath(file)}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					active--;
					pump();
					publish(active === 0 && pending.length === 0);
				}
			})();
		}
	}
	return {
		pause() { paused = true; publish(); },
		resume() { paused = false; pump(); publish(); },
		async cancel(index: number) {
			const row = rows.get(index);
			if (!row) return;
			if (row.status === "pending") {
				const position = pending.findIndex((item) => item.index === index);
				if (position >= 0) pending.splice(position, 1);
				row.status = "canceled";
				publish(active === 0 && pending.length === 0);
			} else if (row.status === "extracting" && stop) {
				try { await stop(row.path, requestIds.get(index)!); if (row.status === "extracting") row.status = "stopping"; publish(); }
				catch (error) { failures.set(index, `${row.path}: ${error instanceof Error ? error.message : String(error)}`); publish(); }
			}
		},
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		append(files: readonly File[]) {
			if (files.length === 0) return;
			if (!snapshot.importing) { failures.clear(); notices.clear(); rows.clear(); requestIds.clear(); sequence = 0; }
			// Unsafe names and unsupported types are summed up per pick; each summary sits where its first file was.
			const unsafe: number[] = [], unsupported: { index: number; extension: string }[] = [];
			for (const file of files) {
				const index = sequence++;
				const path = notesPath(file);
				if (file.webkitRelativePath && hiddenInFolder(file)) continue;
				if (!validNotesPath(path, file.name)) unsafe.push(index);
				else if (!IMPORT_EXTENSIONS.test(file.name)) unsupported.push({ index, extension: extensionLabel(file.name) });
				else if (file.size > MAX_IMPORT_BYTES) failures.set(index, `${path}: Too big. Max 25 MB.`);
				else { requestIds.set(index, crypto.randomUUID()); rows.set(index, { index, path, status: "pending" }); pending.push({ file, index }); }
			}
			if (unsafe.length > 0) failures.set(unsafe[0]!, unsafeSummary(unsafe.length));
			if (unsupported.length > 0) failures.set(unsupported[0]!.index, unsupportedSummary(unsupported.map(({ extension }) => extension)));
			const hadWork = active > 0 || pending.length > 0;
			pump();
			publish(!hadWork);
		},
	};
}

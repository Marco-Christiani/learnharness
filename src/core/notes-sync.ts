import { createHash } from "node:crypto";
import type { NotesSource } from "./contracts/graph.ts";

/** Existing sources keep their IDs when their import path changes. */
export function notesSourceId(filePath: string, sources: readonly NotesSource[] = []): string {
	const matches = sources.filter((source) => source.filePath === filePath);
	if (matches.length > 1) throw new Error(`Multiple sources use ${filePath}. Resolve the duplicate paths before importing.`);
	if (matches.length === 1) return matches[0]!.id;
	const id = `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
	const collision = sources.find((source) => source.id === id);
	if (collision) throw new Error(`This source now uses ${collision.filePath}. Select the folder matching that path before syncing.`);
	return id;
}
export const notesFingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");
export type NotesSyncStatus = "new" | "changed" | "unchanged" | "unverified";

export function notesSyncStatus(source: NotesSource | undefined, text: string): NotesSyncStatus {
	if (!source) return "new";
	if (!source.importFingerprint) return "unverified";
	return source.importFingerprint === notesFingerprint(text) ? "unchanged" : "changed";
}

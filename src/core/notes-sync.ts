import { createHash } from "node:crypto";
import type { NotesSource } from "./contracts/graph.ts";

export const notesSourceId = (filePath: string): string =>
	`src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
export const notesFingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");
export type NotesSyncStatus = "new" | "changed" | "unchanged" | "unverified";

export function notesSyncStatus(source: NotesSource | undefined, text: string): NotesSyncStatus {
	if (!source) return "new";
	if (!source.importFingerprint) return "unverified";
	return source.importFingerprint === notesFingerprint(text) ? "unchanged" : "changed";
}

import assert from "node:assert/strict";
import { it } from "node:test";
import { notesSourceId, notesFingerprint } from "../src/core/notes-sync.ts";
import type { NotesSource } from "../src/core/contracts/graph.ts";

const oldPath = "pages/note.md", newPath = "zet/pages/note.md";
const source: NotesSource = { id: notesSourceId(oldPath), filePath: newPath, importedAt: "2026-11-15", importFingerprint: notesFingerprint("notes") };
it("root migration preserves the source ID and guards its former path", () => {
	assert.equal(notesSourceId(newPath, [source]), source.id);
	assert.notEqual(notesSourceId(newPath), source.id);
	assert.throws(() => notesSourceId(oldPath, [source]), /Select the folder/);
});
it("duplicate canonical paths refuse ambiguous source resolution", () => {
	assert.throws(() => notesSourceId(newPath, [source, { ...source, id: "src_other" }]), /Multiple sources/);
});

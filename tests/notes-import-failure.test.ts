import assert from "node:assert/strict";
import { it } from "node:test";
import { notesImportLimitReached } from "../src/core/notes-import-failure.ts";
it("recognizes provider capacity diagnostics without treating other failures as rate limits", () => {
	for (const message of ["rate_limit_error", "HTTP 429", "Too many requests", "Usage limit reached", "You've hit your limit. Resets 5pm", "quota exhausted", "credit balance too low"]) assert.ok(notesImportLimitReached(message), message);
	for (const message of ["CLI exited with code 1", "Invalid API key", "request aborted", "Malformed JSON"]) assert.equal(notesImportLimitReached(message), false, message);
});

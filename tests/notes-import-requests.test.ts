import assert from "node:assert/strict";
import { it } from "node:test";
import { beginNotesImportRequest, cancelNotesImportRequest } from "../src/server/notes-import-requests.ts";

it("early cancellation survives an upload taking longer than a minute", () => {
	const id = crypto.randomUUID(), now = Date.now;
	try {
		cancelNotesImportRequest(id);
		Date.now = () => now() + 10 * 60_000;
		const request = beginNotesImportRequest(id);
		assert.equal(request.signal.aborted, true);
		request.finish();
	} finally { Date.now = now; }
});

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import { NotesImportReview, matchesNotesExclusion, withNotesDestination } from "../components/notes-import-review.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const restore = installModalDom(dom); after(restore);

it("destination keeps folder-relative paths and file bytes", async () => {
	const file = new File(["notes"], "notes.md");
	Object.defineProperty(file, "webkitRelativePath", { value: "Week/notes.md" });
	const copy = withNotesDestination(file, "Course");
	assert.equal(copy.webkitRelativePath, "Course/Week/notes.md");
	assert.equal(copy.name, file.name);
	assert.equal(await copy.text(), "notes");
});

it("exclusions match literal fragments and wildcards without interpreting regex", () => {
	assert.ok(matchesNotesExclusion("Course/build/log.md", "build/, node_modules/"));
	assert.ok(matchesNotesExclusion("Course/BUILD-LOG.md", "*build-log*"));
	assert.ok(matchesNotesExclusion("Course/[draft]/notes.md", "[draft]"));
	assert.ok(!matchesNotesExclusion("Course/notes.md", "build/, *.log"));
});

it("review waits for preview and syncs only checked files with changed contents", async () => {
	const originalFetch = globalThis.fetch;
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	let confirmed: readonly File[] = [], closed = false;
	const files = ["new.md", "unchanged.md", "log.md"].map((name) => new File(["text"], name));
	const previews: string[] = [];
	globalThis.fetch = async (_url, init) => {
		const form = init!.body as FormData;
		assert.equal(form.get("preview"), "true");
		const path = form.get("paths") as string; previews.push(path);
		return Response.json({ results: [{ requestIndex: 0, filePath: path, ok: true, outcome: "completed", stats: { nodes: 0 }, syncStatus: path === "unchanged.md" ? "unchanged" : "new" }] });
	};
	const button = (prefix: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent!.startsWith(prefix))!;
	try {
		await act(async () => root.render(<InteractionLayersProvider><NotesImportReview files={files} onClose={() => { closed = true; }} onConfirm={(selected) => { confirmed = selected; }} /></InteractionLayersProvider>));
		assert.ok(button("Sync").disabled);
		const boxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		await act(async () => { boxes[2]!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		await act(async () => button("Check changes").click());
		assert.deepEqual(previews, ["new.md", "unchanged.md"]);
		assert.equal(button("Sync").textContent, "Sync 1 files");
		await act(async () => button("Sync").click());
		assert.deepEqual(confirmed.map((file) => file.webkitRelativePath), ["new.md"]);
		assert.ok(closed);
	} finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; }
});

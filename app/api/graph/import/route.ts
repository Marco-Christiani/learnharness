import { notesSourceId, notesSyncStatus, type NotesSyncStatus } from "@/src/server";

/** Validate uploaded notes, preview sync status, or extract selected files. */
import { convertPdf, extraction, joinPages, NotesImportError, sourceDirectory, stores, beginNotesImportRequest, cancelNotesImportRequest, validImportRequestId } from "@/src/server";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES, UNSUPPORTED_TYPE_MESSAGE, validNotesPath } from "@/lib/notes-import-limits.ts";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";
import {
	emit,
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	syncStatus?: NotesSyncStatus;
	error?: string;
	/** Configuration failures expose the settings fields that need attention. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
	/** Shown beside a completed import (every PDF: scanner text may be wrong). */
	notice?: string;
}

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

/** A PDF becomes page-marked Markdown; any other accepted file is read as text. */
async function readNotesFile(file: File): Promise<NotesFile> {
	if (!IMPORT_EXTENSIONS.test(file.name)) return { kind: "refused", error: UNSUPPORTED_TYPE_MESSAGE };
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
		if (bytes.subarray(0, 8192).includes(0)) return { kind: "refused", error: "This file isn't plain text." };
		return { kind: "notes", text: new TextDecoder().decode(bytes) };
	}
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", text, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json({ results: [] as ImportResult[], error: oversized
			? "Import request is too large. Select fewer files."
			: "Could not read the upload. It may be incomplete; please select the files again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: "Too big. Max 25 MB." }, { status: 413 });
	}
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// Folder-relative paths identify sources.
	// Validate every path before conversions, metadata writes, or model calls.
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? suppliedPaths as string[] : files.map((f) => f.name);
	if (files.some((file, i) => !validNotesPath(paths[i]!, file.name))) {
		return Response.json({ results: [], error: "Import contains an unsafe or mismatched relative path" }, { status: 400 });
	}
	const preview = form.get("preview") === "true";
	const requestId = form.get("requestId");
	if (requestId !== null && !validImportRequestId(requestId)) return Response.json({ error: "Invalid import request identity", results: [] }, { status: 400 });
	let lifecycle: ReturnType<typeof beginNotesImportRequest>;
	try { lifecycle = beginNotesImportRequest(requestId ?? undefined); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error), results: [] }, { status: 503 }); }
	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			try {
				if (lifecycle.signal.aborted) throw new NotesImportError("aborted", { nodes: 0, chains: 0 }, "Import stopped.");
				const notes = await readNotesFile(file);
				if (lifecycle.signal.aborted) throw new NotesImportError("aborted", { nodes: 0, chains: 0 }, "Import stopped.");
				if (notes.kind === "refused") {
					results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				const source = stores.graphStore.readSources().find((entry) => entry.id === notesSourceId(filePath));
				const syncStatus = notesSyncStatus(source, notes.text);
				if (preview) {
					results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats: { nodes: 0, chains: 0 }, syncStatus, ...(notes.notice ? { notice: notes.notice } : {}) });
					continue;
				}
				sourceDirectory.registerImport(filePath);
				const stats = await extraction.importNotes({ filePath, text: notes.text, signal: lifecycle.signal });
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats, syncStatus, ...(syncStatus === "unchanged" ? { notice: "Unchanged. Skipped extraction." } : notes.notice ? { notice: notes.notice } : {}) });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: "models_not_configured", missing: err.envelope.missing });
				} else if (err instanceof ProviderKeyMissingError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots });
				} else {
					results.push({ filePath, requestIndex, ok: false,
						outcome: err instanceof NotesImportError ? err.outcome : "failed",
						...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
						error: err instanceof Error ? err.message : String(err) });
				}
			} finally { if (!preview) emit("sources-changed", {}); }
		}
	});
	try { await Promise.all(workers); }
	finally { lifecycle.finish(); }
	return Response.json({ results });
}

export async function DELETE(request: Request) {
	let body: unknown;
	try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
	const id = body && typeof body === "object" && "requestId" in body ? body.requestId : undefined;
	if (!validImportRequestId(id)) return Response.json({ error: "Invalid import request identity" }, { status: 400 });
	try { cancelNotesImportRequest(id); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
	return Response.json({ ok: true });
}

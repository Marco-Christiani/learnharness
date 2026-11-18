import { chunkPoint, type TextChunk } from "@/components/selection-text";
import { splitSentences, type TextSpan } from "./timing";

/**
 * Splits rendered assistant text into read-aloud segments. Prose becomes
 * one verbatim segment per sentence. Code blocks, tables, and display math
 * become one "describe" segment each, which the model voices in a form a
 * listener can follow. Citation chips and controls are skipped.
 */

export type ReadMode = "verbatim" | "describe";

/** A run of contiguous prose, with the DOM chunks behind its text. */
export interface ProseRun {
	text: string;
	chunks: TextChunk[];
}

export type BlockKind = "code" | "table" | "math";

export type ReadSegment =
	| { mode: "verbatim"; text: string; run: ProseRun; span: TextSpan }
	| { mode: "describe"; text: string; element: Element; kind: BlockKind };

type BlockUnit = { element: Element; text: string; kind: BlockKind };

function blockKind(element: Element): BlockKind {
	if (element.matches(".katex-display")) return "math";
	if (element.matches("table, [data-testid=md-table]") || element.querySelector("table")) return "table";
	return "code";
}

const EXCLUDED = "button, input, textarea, select, [role=button], [contenteditable], [hidden], [aria-hidden=true], script, style, template, noscript, svg, [data-testid=citation-chip]";
const DESCRIBED = "[data-testid=md-code], [data-testid=md-table], pre, table, .katex-display";
const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION", "TD", "TH", "TR", "UL"]);
const TEX = 'annotation[encoding="application/x-tex"]';

function describedText(element: Element): string {
	const tex = element.matches(".katex-display") ? element.querySelector(TEX)?.textContent : null;
	if (tex) return `$$${tex}$$`;
	const table = element.matches("table") ? element : element.querySelector("table");
	if (table) {
		return Array.from(table.querySelectorAll("tr"))
			.map((row) => Array.from(row.querySelectorAll("th, td")).map((cell) => cell.textContent?.trim() ?? "").join(" | "))
			.join("\n");
	}
	const code = element.querySelector("pre") ?? element.querySelector("code") ?? element;
	return code.textContent ?? "";
}

/** Prose runs and described blocks, in document order. */
export function readUnits(sources: readonly Element[]): (ProseRun | BlockUnit)[] {
	const units: (ProseRun | BlockUnit)[] = [];
	let run: ProseRun = { text: "", chunks: [] };
	let pendingBreak = false;
	const flush = () => {
		if (run.chunks.length) units.push(run);
		run = { text: "", chunks: [] };
		pendingBreak = false;
	};
	const add = (node: Node, value: string, atomic?: boolean) => {
		if (!value) return;
		if (pendingBreak && run.text.length > 0) run.text += "\n";
		pendingBreak = false;
		run.chunks.push({ node, start: run.text.length, end: run.text.length + value.length, ...(atomic ? { atomic } : {}) });
		run.text += value;
	};
	const walk = (node: Node) => {
		if (node.nodeType === 3) {
			const data = (node as Text).data;
			if (!/\S/.test(data) && node.parentElement && /^(OL|UL|DL|TABLE|THEAD|TBODY|TFOOT|TR)$/.test(node.parentElement.tagName)) return;
			add(node, data);
			return;
		}
		if (node.nodeType !== 1) return;
		const element = node as Element;
		if (element.matches(DESCRIBED)) {
			flush();
			const text = describedText(element).trim();
			if (text) units.push({ element, text, kind: blockKind(element) });
			return;
		}
		if (element.classList.contains("katex")) {
			const tex = element.querySelector(TEX)?.textContent;
			if (tex) add(element, `$${tex}$`, true);
			return;
		}
		if (element.matches(EXCLUDED)) return;
		if (element.tagName === "BR") { pendingBreak = true; return; }
		const block = BLOCKS.has(element.tagName);
		if (block) pendingBreak = true;
		for (const child of Array.from(element.childNodes)) walk(child);
		if (block) pendingBreak = true;
	};
	for (const source of sources) {
		pendingBreak = true;
		walk(source);
	}
	flush();
	return units;
}

/** The raw offsets of `selection` inside a run, or null when it misses the run. */
function selectedSpan(run: ProseRun, selection: Range): TextSpan | null {
	let lo = Infinity;
	let hi = -Infinity;
	for (const chunk of run.chunks) {
		if (!selection.intersectsNode(chunk.node)) continue;
		if (chunk.atomic) { lo = Math.min(lo, chunk.start); hi = Math.max(hi, chunk.end); continue; }
		const length = chunk.end - chunk.start;
		const from = chunk.node === selection.startContainer ? selection.startOffset : 0;
		const to = chunk.node === selection.endContainer ? selection.endOffset : length;
		if (to <= from) continue;
		lo = Math.min(lo, chunk.start + from);
		hi = Math.max(hi, chunk.start + to);
	}
	return hi > lo ? { start: lo, end: hi } : null;
}

/** Read-aloud segments for message sources, optionally limited to a selection. */
export function readSegments(sources: readonly Element[], selection?: Range): ReadSegment[] {
	const segments: ReadSegment[] = [];
	for (const unit of readUnits(sources)) {
		if ("element" in unit) {
			if (!selection || selection.intersectsNode(unit.element)) segments.push({ mode: "describe", text: unit.text, element: unit.element, kind: unit.kind });
			continue;
		}
		const limit = selection ? selectedSpan(unit, selection) : { start: 0, end: unit.text.length };
		if (!limit) continue;
		for (const span of splitSentences(unit.text)) {
			const start = Math.max(span.start, limit.start);
			const end = Math.min(span.end, limit.end);
			if (end <= start) continue;
			const text = unit.text.slice(start, end).trim();
			if (!text) continue;
			const lead = unit.text.slice(start, end).length - unit.text.slice(start, end).trimStart().length;
			segments.push({ mode: "verbatim", text, run: unit, span: { start: start + lead, end: start + lead + text.length } });
		}
	}
	return segments;
}

/** A DOM range over raw offsets of a prose run. */
export function runRange(run: ProseRun, span: TextSpan): Range | null {
	const first = run.chunks[0];
	if (!first) return null;
	const start = chunkPoint(run.chunks, span.start, "start");
	const end = chunkPoint(run.chunks, span.end, "end");
	if (!start || !end) return null;
	const range = first.node.ownerDocument!.createRange();
	if (start.atomic) range.setStartBefore(start.atomic); else range.setStart(start.node, start.offset);
	if (end.atomic) range.setEndAfter(end.atomic); else range.setEnd(end.node, end.offset);
	return range;
}

/** The DOM range a segment highlights as a whole. */
export function segmentRange(segment: ReadSegment): Range | null {
	if (segment.mode === "verbatim") return runRange(segment.run, segment.span);
	const range = segment.element.ownerDocument.createRange();
	range.selectNodeContents(segment.element);
	return range;
}

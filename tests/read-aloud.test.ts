import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { readSegments, readUnits } from "../components/read-aloud/segments.ts";
import { PassageTimeline, splitSentences, wavDurationMs, wordAt } from "../components/read-aloud/timing.ts";

function root(html: string) {
	const { document } = parseHTML(`<html><body><div id="v">${html}</div></body></html>`);
	return document.getElementById("v")!;
}

const slices = (text: string, spans: { start: number; end: number }[]) => spans.map((s) => text.slice(s.start, s.end));

describe("splitSentences", () => {
	it("splits prose into trimmed sentences and breaks at newlines", () => {
		const text = "First one. Second one!  Third?\nA heading\nlast line";
		assert.deepEqual(slices(text, splitSentences(text)), ["First one.", "Second one!", "Third?", "A heading", "last line"]);
	});

	it("drops punctuation-only fragments", () => {
		const text = "Done.\n\u2014\n\u2026";
		assert.deepEqual(slices(text, splitSentences(text)), ["Done."]);
	});
});

describe("wordAt", () => {
	const text = "Alpha beta, gamma.";
	const span = { start: 0, end: text.length };
	it("starts on the first word and ends on the last", () => {
		assert.equal(text.slice(...Object.values(wordAt(text, span, 0)) as [number, number]), "Alpha");
		assert.equal(text.slice(...Object.values(wordAt(text, span, 1)) as [number, number]), "gamma.");
	});

	it("moves forward monotonically", () => {
		let last = -1;
		for (let f = 0; f <= 1; f += 0.05) {
			const { start } = wordAt(text, span, f);
			assert.ok(start >= last);
			last = start;
		}
	});
});

describe("PassageTimeline", () => {
	it("estimates unknown segments at the measured speaking rate", () => {
		const timeline = new PassageTimeline([10, 20, 10]);
		assert.equal(timeline.totalMs, 40 * 65);
		timeline.record(0, 1000); // 100ms per char
		assert.equal(timeline.durationOf(1), 2000);
		assert.equal(timeline.totalMs, 4000);
		assert.deepEqual(timeline.locate(1500), { index: 1, offsetMs: 500 });
		assert.deepEqual(timeline.locate(99_999), { index: 2, offsetMs: 1000 });
	});

	it("derives WAV duration from byte length", () => {
		assert.equal(wavDurationMs(44 + 48_000), 1000);
	});
});

describe("readSegments", () => {
	const html = `<div data-source-message-id="m1">
		<p>Hello there. This has <code>inline</code> code and <span data-testid="citation-chip"><button>src</button></span> a chip.</p>
		<div data-testid="md-code"><button>Copy</button><pre><code>const x = 1;</code></pre></div>
		<ul><li>Item one</li><li>Item two</li></ul>
		<div data-testid="md-table"><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></div>
		<p>The end.</p>
	</div>`;

	it("reads prose verbatim by sentence and describes code and tables", () => {
		const segments = readSegments([root(html).firstElementChild!]);
		assert.deepEqual(segments.map((s) => [s.mode, s.text]), [
			["verbatim", "Hello there."],
			["verbatim", "This has inline code and  a chip."],
			["describe", "const x = 1;"],
			["verbatim", "Item one"],
			["verbatim", "Item two"],
			["describe", "a | b\n1 | 2"],
			["verbatim", "The end."],
		]);
	});

	it("keeps each verbatim span aligned with its run text", () => {
		for (const segment of readSegments([root(html).firstElementChild!])) {
			if (segment.mode === "verbatim") assert.equal(segment.run.text.slice(segment.span.start, segment.span.end), segment.text);
		}
	});

	it("reads formulas as TeX", () => {
		const v = root(`<p>Area is <span class="katex"><annotation encoding="application/x-tex">\\pi r^2</annotation></span>.</p>`);
		const units = readUnits([v]);
		assert.equal("text" in units[0]! && !("element" in units[0]!) ? units[0].text : "", "Area is $\\pi r^2$.");
	});
});

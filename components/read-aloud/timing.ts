/**
 * Read-aloud timing without provider word timestamps. Realtime returns no
 * alignment, so a word's position inside a segment is estimated from the
 * fraction of the segment's audio already played, with each character
 * counting equally and punctuation adding pause weight.
 */

export interface TextSpan {
	start: number;
	end: number;
}

const SPEAKABLE = /[\p{L}\p{N}$\\]/u;

/** Sentence spans of prose text. A newline always ends a sentence (block boundaries become "\n"). */
export function splitSentences(text: string, locale = "en"): TextSpan[] {
	const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
	const spans: TextSpan[] = [];
	let lineStart = 0;
	for (const line of text.split("\n")) {
		for (const { segment, index } of segmenter.segment(line)) {
			const lead = segment.length - segment.trimStart().length;
			const body = segment.trim();
			if (!body || !SPEAKABLE.test(body)) continue;
			const start = lineStart + index + lead;
			spans.push({ start, end: start + body.length });
		}
		lineStart += line.length + 1;
	}
	return spans;
}

const SENTENCE_PAUSE = 8;
const CLAUSE_PAUSE = 4;

function weight(char: string): number {
	if (/\s/.test(char)) return 0;
	if (".!?".includes(char)) return 1 + SENTENCE_PAUSE;
	if (",;:".includes(char)) return 1 + CLAUSE_PAUSE;
	return 1;
}

/** The word of `text[span]` that `fraction` of the way through its audio falls on. */
export function wordAt(text: string, span: TextSpan, fraction: number): TextSpan {
	if (span.end <= span.start) return span;
	let total = 0;
	for (let i = span.start; i < span.end; i++) total += weight(text[i]!);
	const target = Math.floor(total * Math.min(Math.max(fraction, 0), 1));
	let seen = 0;
	let offset = span.start;
	while (offset < span.end - 1) {
		seen += weight(text[offset]!);
		if (seen > target) break;
		offset++;
	}
	// whitespace has no weight, so the walk stops on a word character
	let start = offset;
	while (start > span.start && !/\s/.test(text[start - 1]!)) start--;
	let end = offset + 1;
	while (end < span.end && !/\s/.test(text[end]!)) end++;
	return { start, end };
}

const DEFAULT_MS_PER_CHAR = 65;

/**
 * Positions across a passage of segments. Segments without audio yet are
 * estimated from their length at the speaking rate measured so far.
 */
export class PassageTimeline {
	private readonly known: (number | null)[];

	constructor(private readonly lengths: readonly number[]) {
		this.known = lengths.map(() => null);
	}

	get count(): number {
		return this.lengths.length;
	}

	get totalMs(): number {
		return this.startOf(this.lengths.length);
	}

	record(index: number, durationMs: number): void {
		this.known[index] = durationMs;
	}

	isKnown(index: number): boolean {
		return this.known[index] != null;
	}

	durationOf(index: number): number {
		return this.duration(index, this.msPerChar());
	}

	startOf(index: number): number {
		const rate = this.msPerChar();
		let sum = 0;
		for (let i = 0; i < index; i++) sum += this.duration(i, rate);
		return sum;
	}

	locate(positionMs: number): { index: number; offsetMs: number } {
		const rate = this.msPerChar();
		let remaining = Math.max(positionMs, 0);
		for (let i = 0; i < this.lengths.length; i++) {
			const d = this.duration(i, rate);
			if (remaining < d) return { index: i, offsetMs: remaining };
			remaining -= d;
		}
		const last = Math.max(this.lengths.length - 1, 0);
		return { index: last, offsetMs: this.duration(last, rate) };
	}

	private duration(index: number, rate: number): number {
		return this.known[index] ?? (this.lengths[index] ?? 0) * rate;
	}

	private msPerChar(): number {
		let ms = 0;
		let chars = 0;
		this.known.forEach((d, i) => {
			if (d != null) { ms += d; chars += this.lengths[i]!; }
		});
		return chars > 0 ? ms / chars : DEFAULT_MS_PER_CHAR;
	}
}

/** Duration of a mono 16-bit PCM WAV with a canonical 44-byte header, from its byte length and sample rate. */
export function wavDurationMs(bytes: number, sampleRate = 24_000): number {
	return Math.max(bytes - 44, 0) / 2 / sampleRate * 1000;
}

/** Request identities connect Stop to uploads, conversion, and extraction. */
interface ImportRequest { controller: AbortController; expiresAt: number; }
const registry = () => {
	const global = globalThis as typeof globalThis & { __lhNotesImportRequests?: Map<string, ImportRequest> };
	const requests = global.__lhNotesImportRequests ??= new Map();
	for (const [id, request] of requests) if (request.expiresAt < Date.now()) requests.delete(id);
	return requests;
};
const MAX_TRACKED_REQUESTS = 4096;
function requireCapacity(requests: Map<string, ImportRequest>, id: string | undefined) {
	if (id && !requests.has(id) && requests.size >= MAX_TRACKED_REQUESTS) throw new Error("Too many tracked imports. Restart the development server before importing more files.");
}
export const validImportRequestId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function beginNotesImportRequest(id: string | undefined) {
	const requests = registry();
	requireCapacity(requests, id);
	const request = (id && requests.get(id)) || { controller: new AbortController(), expiresAt: Infinity };
	request.expiresAt = Infinity;
	if (id) requests.set(id, request);
	return { signal: request.controller.signal, finish: () => { if (id) request.expiresAt = Date.now() + 60_000; } };
}

export function cancelNotesImportRequest(id: string): void {
	const requests = registry();
	requireCapacity(requests, id);
	const request = requests.get(id) ?? { controller: new AbortController(), expiresAt: Infinity };
	request.controller.abort();
	requests.set(id, request);
}

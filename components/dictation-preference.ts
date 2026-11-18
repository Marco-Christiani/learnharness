"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationEngine, isDictationLanguage, sanitizeUserSettings,
	type DictationEngine, type DictationLanguage, type DictationSettings, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = { language: undefined as DictationLanguage | undefined, engine: undefined as DictationEngine | undefined, saving: false, error: null as string | null };

/** One confirmed preference and one write in flight, shared by every surface.
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<DictationLanguage> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				const language = record?.dictation?.language ?? FACTORY_SETTINGS.dictation.language;
				const engine = record?.dictation?.engine ?? FACTORY_SETTINGS.dictation.engine;
				needsRead = false;
				publish({ language, engine, error: null });
				return language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	function save(language: DictationLanguage): Promise<boolean> {
		return write({ language }, "language");
	}

	function saveEngine(engine: DictationEngine): Promise<boolean> {
		return write({ engine }, "engine");
	}

	// the settings route replaces the whole section, so every write carries both fields
	function write(patch: DictationSettings, field: "language" | "engine"): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ language: snapshot.language, engine: snapshot.engine ?? FACTORY_SETTINGS.dictation.engine, ...patch }),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation?.language;
				const engine = body.settings?.dictation?.engine ?? FACTORY_SETTINGS.dictation.engine;
				if (!isDictationLanguage(confirmed) || !isDictationEngine(engine)) throw new Error();
				needsRead = false;
				publish({ language: confirmed, engine, error: null });
				saved();
				return true;
			} catch {
				publish({ error: `Could not save dictation ${field}. Try again.` });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	async function getLanguage(): Promise<DictationLanguage> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else return snapshot.language;
		}
	}

	async function getEngine(): Promise<DictationEngine> {
		await getLanguage();
		return snapshot.engine ?? FACTORY_SETTINGS.dictation.engine;
	}

	return {
		load, save, saveEngine, getLanguage, getEngine,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, saveEngine: store.saveEngine, getLanguage: store.getLanguage, getEngine: store.getEngine };
}

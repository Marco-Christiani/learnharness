/** Provider capacity and account limits require intervention before more imports. */
export function notesImportLimitReached(message: string): boolean {
	return /rate[-_ ]?limit|too many requests|\b429\b|usage limit|(?:you(?:'|\u2019)ve|you have) hit your limit|quota (?:exceeded|exhausted)|insufficient credits|credit balance/i.test(message);
}

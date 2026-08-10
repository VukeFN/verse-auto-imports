/** Which of the extractor's routes produced a suggestion. */
export type ImportSuggestionSource = "error_message" | "digest_lookup" | "inference";

/**
 * How far a suggestion can be trusted. Anything below "high" is labelled in
 * the quick-fix title when descriptions are on; it does not affect ordering.
 */
export type ImportConfidence = "high" | "medium" | "low";

/** One offered import, ready to be written into a document. */
export interface ImportSuggestion {
    importStatement: string;
    source: ImportSuggestionSource;
    confidence: ImportConfidence;
    description?: string;

    /**
     * The path alone, taken back out of `importStatement`. Undefined where it
     * could not be extracted, so callers must not treat it as always present.
     */
    modulePath?: string;
}

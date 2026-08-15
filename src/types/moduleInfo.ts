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

/**
 * The 0-based lines of the diagnostics that asked for each import, keyed on the
 * import's trimmed path. A path with no entry is placed by the written order
 * alone, so a key carrying surrounding whitespace silently supplies no
 * evidence rather than failing.
 *
 * Placement reads these to tell a pinned import that failed to resolve from one
 * that merely looks as though it could
 * (ImportDocumentEditor.couldResolveAgainst). The line is a diagnostic's start
 * line, so every producer must record that same one or the span test compares
 * unlike things.
 */
export type DiagnosticLinesByPath = ReadonlyMap<string, readonly number[]>;

/**
 * The same lines keyed on the whole import statement rather than on the path,
 * for a caller holding statements. Distinct from DiagnosticLinesByPath only in
 * its key, which the structural type cannot express: passing one where the
 * other belongs silently supplies no evidence at all.
 */
export type DiagnosticLinesByStatement = ReadonlyMap<string, readonly number[]>;

/** What a set of compiler diagnostics asks to be imported, and where each was reported. */
export interface MissingImports {
    /** Deduplicated, in the order the diagnostics named them. */
    paths: string[];
    diagnosticLinesByPath: DiagnosticLinesByPath;
}

/**
 * The parts of a project-local module path.
 *
 * Nothing in `src/` constructs or reads one, and the field names do not carry
 * enough to reconstruct what each segment spans. Establish that from a real
 * call site before relying on it; do not infer a contract from the names.
 */
export interface ModuleInfo {
    projectName: string;
    intermediatePath: string;
    outerModule: string;
    internalModule: string;
}

/** Which of the extractor's routes produced a suggestion. */
export type ImportSuggestionSource = "error_message" | "digest_lookup" | "inference";

/**
 * How far a suggestion can be trusted. Anything below "high" is labelled in
 * the quick-fix title when descriptions are on; it does not affect ordering.
 */
export type ImportConfidence = "high" | "medium" | "low";

/**
 * What to do when a diagnostic offers several import paths. Unused: the live
 * setting is read as a plain string in `DiagnosticsHandler`, so adding a case
 * here changes nothing on its own.
 */
export type MultiOptionStrategy = "quickfix" | "auto_shortest" | "auto_first" | "disabled";

/** Unused; no setting or call site in `src/` corresponds to it. */
export type UnknownIdentifierResolution = "digest_only" | "digest_and_inference" | "disabled";

/** Unused; no setting or call site in `src/` corresponds to it. */
export type QuickFixOrdering = "confidence" | "alphabetical" | "module_priority";

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

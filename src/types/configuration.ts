/**
 * The shape of the `verseAutoImports` settings section, mirroring the
 * configuration contribution in package.json.
 *
 * Nothing in `src/` reads these types: every call site goes through
 * `getConfiguration("verseAutoImports").get<T>(key, default)` with an inline
 * type argument. They therefore drift silently - the `cache` section has no
 * interface here at all - so treat package.json as the authority and these as
 * a summary of it.
 */

/**
 * Which documents the debounced auto-import is allowed to touch. Quick fixes
 * and CodeLens are unaffected in every scope; this only bounds the automatic
 * path, which edits without the user asking.
 */
export type AutoImportScope = "allFiles" | "openFiles" | "activeFile";

/** The `verseAutoImports.general` settings. */
export interface GeneralConfig {
    autoImport: boolean;

    /** Superseded by autoImportDebounceDelay, and read only when explicitly set. */
    diagnosticDelay: number;

    autoImportDebounceDelay: number;
    autoImportScope: AutoImportScope;
}

/** The `verseAutoImports.behavior` settings: how an import is written. */
export interface BehaviorConfig {
    importSyntax: "curly" | "dot";
    preserveImportLocations: boolean;
    sortImportsAlphabetically: boolean;
    importGrouping: "none" | "digestFirst" | "localFirst";
    emptyLinesAfterImports: number;
    ambiguousImports: Record<string, string>;
    multiOptionStrategy: "quickfix" | "auto_shortest" | "auto_first" | "disabled";
    digestImportPrefixes: string[];
}

/** The `verseAutoImports.quickFix` settings: how the offered fixes are listed. */
export interface QuickFixConfig {
    sortAlphabetically: boolean;
    showDescriptions: boolean;
}

/** The `verseAutoImports.pathConversion` settings: the CodeLens on an import. */
export interface PathConversionConfig {
    enableCodeLens: boolean;
    codeLensVisibility: "hover" | "always";
    codeLensHideDelay: number;
}

/** The `verseAutoImports.experimental` settings. */
export interface ExperimentalConfig {
    useDigestFiles: boolean;
}

/** Every section above, as one object. */
export interface VerseAutoImportsConfig {
    general: GeneralConfig;
    behavior: BehaviorConfig;
    quickFix: QuickFixConfig;
    pathConversion: PathConversionConfig;
    experimental: ExperimentalConfig;
}

/**
 * Configuration types for the Verse Auto Imports extension
 */

/**
 * Which documents the debounced auto-import is allowed to touch. Quick fixes
 * and CodeLens are unaffected in every scope; this only bounds the automatic
 * path, which edits without the user asking.
 */
export type AutoImportScope = "allFiles" | "openFiles" | "activeFile";

export interface GeneralConfig {
    autoImport: boolean;
    diagnosticDelay: number; // Deprecated
    autoImportDebounceDelay: number;
    autoImportScope: AutoImportScope;
}

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

export interface QuickFixConfig {
    sortAlphabetically: boolean;
    showDescriptions: boolean;
}

export interface PathConversionConfig {
    enableCodeLens: boolean;
    codeLensVisibility: "hover" | "always";
    codeLensHideDelay: number;
}

export interface ExperimentalConfig {
    useDigestFiles: boolean;
}

export interface VerseAutoImportsConfig {
    general: GeneralConfig;
    behavior: BehaviorConfig;
    quickFix: QuickFixConfig;
    pathConversion: PathConversionConfig;
    experimental: ExperimentalConfig;
}

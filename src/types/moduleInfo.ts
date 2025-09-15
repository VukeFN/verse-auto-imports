export interface ModuleInfo {
    projectName: string;
    intermediatePath: string;
    outerModule: string;
    internalModule: string;
}

export type ImportSuggestionSource = 'error_message' | 'digest_lookup' | 'inference';
export type ImportConfidence = 'high' | 'medium' | 'low';
export type MultiOptionStrategy = 'quickfix' | 'auto_shortest' | 'auto_first' | 'disabled';
export type UnknownIdentifierResolution = 'digest_only' | 'digest_and_inference' | 'disabled';
export type QuickFixOrdering = 'confidence' | 'alphabetical' | 'module_priority';

export interface ImportSuggestion {
    importStatement: string;
    source: ImportSuggestionSource;
    confidence: ImportConfidence;
    description?: string;
    modulePath?: string; // The actual module path extracted from the import statement
}
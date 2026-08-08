import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportSuggestion, ImportSuggestionSource, ImportConfidence } from "../types";
import { DigestParser, AssetsDigestParser } from "../services";
import { ImportFormatter } from "./ImportFormatter";

// Regex patterns for error message parsing
const PATTERNS = {
    /** "Did you mean any of:\n<options>" */
    DID_YOU_MEAN_ANY: /Did you mean any of:\s*\n(.+)/s,
    /** "Did you forget to specify one of:\nusing { /Path }" */
    FORGET_ONE_OF: /Did you forget to specify one of:\s*\n((?:using \{[^}]+\}\s*\n?)+)/s,
    /** "Identifier X could be one of many types: (/Path1:)X or (/Path2:)X" */
    IDENTIFIER_MANY_TYPES: /Identifier \w+ could be one of many types:\s*(.+)/,
    /** "Did you forget to specify using { /Path }" */
    FORGET_SINGLE: /Did you forget to specify using \{ (\/[^}]+) \}/,
    /** "Unknown identifier `x`. Did you forget to specify using { /Path }" */
    UNKNOWN_WITH_SUGGESTION: /Unknown identifier `[^`]+`.*Did you forget to specify using \{ (\/[^}]+) \}/s,
    /** "Unknown identifier `x`" */
    UNKNOWN_IDENTIFIER: /Unknown identifier `([^`]+)`/,
    /** "Did you mean X" (single suggestion) */
    DID_YOU_MEAN_SINGLE: /Did you mean ([^`\n]+)/,
    /** Extracts path from "using { /Path }" */
    USING_PATH: /using \{ (\/[^}]+) \}/g,
    /** Extracts path from "(/Path:)" format */
    PATH_IN_PARENS: /\((\/[^:)]+):\)/g,
} as const;

/**
 * A dotted chain of Verse identifiers, e.g. "Module.Submodule.Name". Not part
 * of the PATTERNS precedence cascade: it validates an already-extracted
 * candidate rather than parsing a compiler message.
 */
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Fallback for behavior.ambiguousImports. package.json is the source of truth
 * and registers exactly these three mappings; config.get returns the registered
 * default for a registered setting, so an empty fallback never reached
 * production and only ever changed what the tests saw. Keep the two in step.
 */
const DEFAULT_AMBIGUOUS_IMPORTS: Record<string, string> = {
    vector3: "/UnrealEngine.com/Temporary/SpatialMath",
    vector2: "/UnrealEngine.com/Temporary/SpatialMath",
    rotation: "/UnrealEngine.com/Temporary/SpatialMath",
};

/** A resolvable import extracted from a compiler message. */
interface ImportCandidate {
    path: string;
    description: string;
}

/**
 * Classification of a single compiler message. Both extraction entry points
 * (suggestion extraction for auto-import/quick fixes and path extraction for
 * Optimize Imports) consume this, so message filters and pattern precedence
 * exist exactly once.
 */
type DiagnosticClassification =
    | { kind: "ignored" }
    | { kind: "none" }
    | { kind: "multiOption"; candidates: ImportCandidate[] }
    | { kind: "singleImport"; candidate: ImportCandidate }
    | { kind: "identifier"; identifier: string; inferred?: ImportCandidate };

/**
 * Handles parsing error messages and diagnostics to extract import suggestions.
 */
export class ImportSuggestionExtractor {
    private readonly digestParser: DigestParser;
    private readonly formatter: ImportFormatter;
    private readonly assetsDigestParser: AssetsDigestParser | null;

    constructor(outputChannel: vscode.OutputChannel, formatter: ImportFormatter, assetsDigestParser?: AssetsDigestParser, extensionContext?: vscode.ExtensionContext) {
        this.digestParser = new DigestParser(outputChannel, extensionContext);
        this.formatter = formatter;
        this.assetsDigestParser = assetsDigestParser || null;
    }

    /**
     * Extracts paths from "using { /Path }" format.
     */
    private extractUsingPaths(text: string): string[] {
        const paths: string[] = [];
        const pattern = new RegExp(PATTERNS.USING_PATH.source, "g");
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            paths.push(match[1]);
        }
        return paths;
    }

    /**
     * Extracts paths from "(/Path:)" format (used in "Identifier could be one of many types").
     */
    private extractParenPaths(text: string): string[] {
        const paths: string[] = [];
        const pattern = new RegExp(PATTERNS.PATH_IN_PARENS.source, "g");
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            paths.push(match[1]);
        }
        return paths;
    }

    /**
     * Finds the correct module path from a fully qualified name by checking
     * if any intermediate segments are known asset class names.
     *
     * @param fullName The fully qualified name (e.g., "Ake.UI.UI_UMG.ClassName")
     * @returns The correct module path and class name, or null if invalid
     */
    private findCorrectModulePath(fullName: string): { modulePath: string; className: string } | null {
        // "Did you mean" captures raw sentence text, so trailing punctuation
        // ("Economy.Shop.") or prose ("to use Bar.Baz instead?") reaches this
        // point; splitting those would produce a plausible-looking but wrong
        // import. Anything that is not a dotted identifier chain is dropped.
        if (!QUALIFIED_NAME.test(fullName)) {
            logger.debug("ImportSuggestionExtractor", `Rejecting suggestion text that is not a dotted identifier chain: ${fullName}`);
            return null;
        }

        const parts = fullName.split(".");
        if (parts.length < 2) {
            return null;
        }

        // Check from second-to-last segment backwards to find asset class names
        // The last segment is always assumed to be the actual identifier being referenced
        for (let i = parts.length - 2; i > 0; i--) {
            const segment = parts[i];

            // Check if this segment is a known asset class name
            if (this.assetsDigestParser?.isAssetClassName(segment)) {
                // This segment is a class, so the module path is everything before it
                const modulePath = parts.slice(0, i).join(".");
                const className = parts[parts.length - 1];

                logger.debug("ImportSuggestionExtractor", `Found asset class '${segment}' in path '${fullName}'. Module: ${modulePath}, Class: ${className}`);

                return { modulePath, className };
            }
        }

        // No asset class found in intermediate segments - use default behavior
        // (last segment is the class, everything else is the module)
        const lastDotIndex = fullName.lastIndexOf(".");
        return {
            modulePath: fullName.substring(0, lastDotIndex),
            className: fullName.substring(lastDotIndex + 1),
        };
    }

    /**
     * Parses error messages for multi-option import candidates.
     * Handles three patterns:
     * 1. "Did you mean any of:\n<options>"
     * 2. "Did you forget to specify one of:\nusing { /Path }\nusing { /Path }"
     * 3. "Identifier X could be one of many types: (/Path1:)X or (/Path2:)X"
     *
     * Returns null when no multi-option pattern matches; an empty array when a
     * pattern matched but no option was importable (e.g. only bare identifiers).
     */
    private parseMultiOptionCandidates(errorMessage: string): ImportCandidate[] | null {
        // Pattern 1: "Did you mean any of:\n<options>"
        const match1 = errorMessage.match(PATTERNS.DID_YOU_MEAN_ANY);
        if (match1) {
            const options = match1[1]
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            logger.debug("ImportSuggestionExtractor", `Found ${options.length} multi-options (pattern 1): ${options.join(", ")}`);

            const candidates: ImportCandidate[] = [];
            for (const option of options) {
                if (option.startsWith("/")) {
                    // Direct module path
                    candidates.push({ path: option, description: `Import from ${option}` });
                    continue;
                }
                // Fully qualified name (e.g., "Module.ClassName" or "Module.AssetClass.Member")
                const result = this.findCorrectModulePath(option);
                if (result && result.modulePath) {
                    candidates.push({ path: result.modulePath, description: `${result.className} from ${result.modulePath}` });
                } else {
                    // Bare identifiers (e.g. a local definition echoed in the option
                    // list) carry no module path and are not importable.
                    logger.debug("ImportSuggestionExtractor", `Dropping non-importable multi-option entry: ${option}`);
                }
            }
            return candidates;
        }

        // Pattern 2: "Did you forget to specify one of:\nusing { /Path }\nusing { /Path }"
        const match2 = errorMessage.match(PATTERNS.FORGET_ONE_OF);
        if (match2) {
            const options = this.extractUsingPaths(match2[1]);
            logger.debug("ImportSuggestionExtractor", `Found ${options.length} multi-options (pattern 2): ${options.join(", ")}`);
            return options.map((path) => ({ path, description: `Import from ${path}` }));
        }

        // Pattern 3: "Identifier X could be one of many types: (/Path1:)X or (/Path2:)X"
        const match3 = errorMessage.match(PATTERNS.IDENTIFIER_MANY_TYPES);
        if (match3) {
            const options = this.extractParenPaths(match3[1]);
            logger.debug("ImportSuggestionExtractor", `Found ${options.length} multi-options (pattern 3): ${options.join(", ")}`);
            return options.map((path) => ({ path, description: `Import from ${path}` }));
        }

        return null;
    }

    /**
     * Derives an import candidate from a "Did you mean Namespace.Component"
     * suggestion. Returns null for suggestions without a module path (single
     * segment names never produce an import).
     */
    private inferFromDidYouMean(errorMessage: string): ImportCandidate | null {
        const didYouMeanMatch = errorMessage.match(PATTERNS.DID_YOU_MEAN_SINGLE);
        if (!didYouMeanMatch) {
            return null;
        }
        const fullName = didYouMeanMatch[1].trim();
        const result = this.findCorrectModulePath(fullName);
        if (result && result.modulePath) {
            return { path: result.modulePath, description: `Inferred import for ${fullName}` };
        }
        return null;
    }

    /**
     * Classifies a compiler message into exactly one import-relevant category.
     * Pattern precedence is load-bearing: multi-option patterns are checked
     * before single-option ones so a new pattern must not shadow an existing one.
     */
    private classifyMessage(errorMessage: string): DiagnosticClassification {
        // Assignment hints ("Did you mean to write 'set ...'") are never import problems
        if (errorMessage.includes("Did you mean to write 'set")) {
            logger.debug("ImportSuggestionExtractor", `Ignoring 'set' suggestion error`);
            return { kind: "ignored" };
        }

        // Fast path: nothing import-shaped in the message
        if (
            !errorMessage.includes("using") &&
            !errorMessage.includes("Unknown identifier") &&
            !errorMessage.includes("Did you forget") &&
            !errorMessage.includes("Did you mean") &&
            !errorMessage.includes("could be one of many types")
        ) {
            return { kind: "none" };
        }

        // Multi-option patterns first. A single surviving candidate is
        // unambiguous; an empty result falls through so the unknown-identifier
        // handling below still gets a chance to resolve the message.
        const candidates = this.parseMultiOptionCandidates(errorMessage);
        if (candidates !== null) {
            if (candidates.length > 1) {
                return { kind: "multiOption", candidates };
            }
            if (candidates.length === 1) {
                return { kind: "singleImport", candidate: candidates[0] };
            }
        }

        // "Unknown identifier `x`. Did you forget to specify using { /Path }"
        const specificMatch = errorMessage.match(PATTERNS.UNKNOWN_WITH_SUGGESTION);
        if (specificMatch) {
            const identifierMatch = errorMessage.match(PATTERNS.UNKNOWN_IDENTIFIER);
            const name = identifierMatch ? identifierMatch[1] : specificMatch[1];
            return { kind: "singleImport", candidate: { path: specificMatch[1], description: `Import ${name} from ${specificMatch[1]}` } };
        }

        // "Did you forget to specify using { /Path }"
        const forgetMatch = errorMessage.match(PATTERNS.FORGET_SINGLE);
        if (forgetMatch) {
            return { kind: "singleImport", candidate: { path: forgetMatch[1], description: `Standard import for ${forgetMatch[1]}` } };
        }

        // "Unknown identifier `x`" without an inline path: the consumer decides
        // how to resolve it (configured mapping, digest lookup, or the inferred
        // "Did you mean" path).
        const unknownMatch = errorMessage.match(PATTERNS.UNKNOWN_IDENTIFIER);
        if (unknownMatch) {
            const inferred = this.inferFromDidYouMean(errorMessage);
            return { kind: "identifier", identifier: unknownMatch[1], inferred: inferred ?? undefined };
        }

        // "Did you mean Namespace.Component" without an unknown-identifier prefix
        const inferred = this.inferFromDidYouMean(errorMessage);
        if (inferred) {
            return { kind: "singleImport", candidate: inferred };
        }

        return { kind: "none" };
    }

    /**
     * Creates an ImportSuggestion object.
     */
    private createImportSuggestion(importStatement: string, source: ImportSuggestionSource, confidence: ImportConfidence, description?: string): ImportSuggestion {
        const modulePath = this.formatter.extractPathFromImport(importStatement);
        return {
            importStatement,
            source,
            confidence,
            description,
            modulePath: modulePath || undefined,
        };
    }

    /**
     * Looks up an identifier in digest files for import suggestions.
     */
    private async lookupIdentifierInDigest(identifier: string): Promise<ImportSuggestion[]> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const useDigestFiles = config.get<boolean>("experimental.useDigestFiles", false);
        const preferDotSyntax = config.get<string>("behavior.importSyntax", "curly") === "dot";

        if (!useDigestFiles) {
            return [];
        }

        try {
            const digestEntries = await this.digestParser.lookupIdentifier(identifier);
            const suggestions: ImportSuggestion[] = [];

            for (const entry of digestEntries) {
                if (!entry.modulePath) {
                    continue;
                }

                const importStatement = this.formatter.formatImportStatement(entry.modulePath, preferDotSyntax);
                const confidence: ImportConfidence = entry.identifier === identifier ? "high" : "medium";
                const description = `${entry.type} from ${entry.modulePath}`;

                suggestions.push(this.createImportSuggestion(importStatement, "digest_lookup", confidence, description));
            }

            if (suggestions.length > 0) {
                logger.debug("ImportSuggestionExtractor", `Found ${suggestions.length} digest-based suggestions for: ${identifier}`);
            }

            return suggestions;
        } catch (error) {
            logger.error("ImportSuggestionExtractor", `Error looking up identifier in digest`, error);
            return [];
        }
    }

    /**
     * Extracts import suggestions from an error message.
     * This is the main method for parsing compiler errors.
     */
    async extractImportSuggestions(errorMessage: string): Promise<ImportSuggestion[]> {
        logger.debug("ImportSuggestionExtractor", `Extracting import suggestions from error: ${errorMessage}`);

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax = config.get<string>("behavior.importSyntax", "curly") === "dot";
        const ambiguousImportMappings = config.get<Record<string, string>>("behavior.ambiguousImports", DEFAULT_AMBIGUOUS_IMPORTS);

        const classification = this.classifyMessage(errorMessage);

        switch (classification.kind) {
            case "ignored":
            case "none":
                logger.debug("ImportSuggestionExtractor", "No import suggestions found in error message");
                return [];

            case "multiOption":
                logger.debug("ImportSuggestionExtractor", `Found multi-option pattern with ${classification.candidates.length} options`);
                return classification.candidates.map((candidate) =>
                    this.createImportSuggestion(this.formatter.formatImportStatement(candidate.path, preferDotSyntax), "error_message", "high", candidate.description),
                );

            case "singleImport": {
                const importStatement = this.formatter.formatImportStatement(classification.candidate.path, preferDotSyntax);
                logger.debug("ImportSuggestionExtractor", `Found import statement: ${importStatement}`);
                return [this.createImportSuggestion(importStatement, "error_message", "high", classification.candidate.description)];
            }

            case "identifier": {
                // Configured ambiguous mappings take precedence
                if (ambiguousImportMappings[classification.identifier]) {
                    const preferredPath = ambiguousImportMappings[classification.identifier];
                    const importStatement = this.formatter.formatImportStatement(preferredPath, preferDotSyntax);
                    logger.debug("ImportSuggestionExtractor", `Using configured path for ambiguous class ${classification.identifier}: ${importStatement}`);
                    return [this.createImportSuggestion(importStatement, "error_message", "high", `Configured import for ${classification.identifier}`)];
                }

                // Then digest-based lookup
                const digestSuggestions = await this.lookupIdentifierInDigest(classification.identifier);
                if (digestSuggestions.length > 0) {
                    logger.debug("ImportSuggestionExtractor", `Found digest-based suggestions for unknown identifier: ${classification.identifier}`);
                    return digestSuggestions;
                }

                // Finally the path inferred from a "Did you mean" suggestion
                if (classification.inferred) {
                    const importStatement = this.formatter.formatImportStatement(classification.inferred.path, preferDotSyntax);
                    logger.debug("ImportSuggestionExtractor", `Inferred import statement: ${importStatement}`);
                    return [this.createImportSuggestion(importStatement, "error_message", "high", classification.inferred.description)];
                }

                logger.debug("ImportSuggestionExtractor", "No import suggestions found in error message");
                return [];
            }

            default: {
                const exhaustive: never = classification;
                return exhaustive;
            }
        }
    }

    /**
     * Extracts unambiguous import paths from VS Code diagnostics for the
     * Optimize Imports command. Only single, unambiguous suggestions are
     * collected: multi-option (ambiguous) messages need a user choice and are
     * left to the quick-fix menu, and non-import messages contribute nothing.
     */
    extractImportsFromDiagnostics(diagnostics: vscode.Diagnostic[]): string[] {
        logger.debug("ImportSuggestionExtractor", `Extracting imports from ${diagnostics.length} diagnostics`);

        const suggestedPaths = new Set<string>();

        for (const diagnostic of diagnostics) {
            const classification = this.classifyMessage(diagnostic.message);

            switch (classification.kind) {
                case "singleImport":
                    suggestedPaths.add(classification.candidate.path);
                    logger.debug("ImportSuggestionExtractor", `Found path: ${classification.candidate.path}`);
                    break;

                case "identifier":
                    if (classification.inferred) {
                        suggestedPaths.add(classification.inferred.path);
                        logger.debug("ImportSuggestionExtractor", `Found inferred path: ${classification.inferred.path}`);
                    }
                    break;

                case "multiOption":
                    // Ambiguous candidates need a user choice; never bulk-add them
                    logger.debug("ImportSuggestionExtractor", `Skipping ambiguous diagnostic with ${classification.candidates.length} candidates`);
                    break;

                case "ignored":
                case "none":
                    break;

                default: {
                    const exhaustive: never = classification;
                    return exhaustive;
                }
            }
        }

        const result = Array.from(suggestedPaths);
        logger.debug("ImportSuggestionExtractor", `Extracted ${result.length} unique import paths from diagnostics`);
        return result;
    }
}

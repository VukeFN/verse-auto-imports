import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportSuggestion, ImportSuggestionSource, ImportConfidence, MissingImports } from "../types";
import { DigestParser, AssetsDigestParser } from "../services";
import { ImportFormatter } from "./ImportFormatter";

// Each entry is documented by the compiler text it matches, since the message
// wording is the contract these depend on. Precedence between them lives in
// classifyMessage, not here.
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
    /**
     * The " or did you forget to specify " that joins same-package suggestions
     * to external ones inside a single message. Either case of "did" matches:
     * the compiler composes this phrase inline rather than at a sentence start,
     * and which case it uses there is not established.
     */
    MIXED_JOINER: / or [Dd]id you forget to specify /,
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
 * and registers {} as the default; keep the two in step. Only a caller with
 * no registered setting behind it, such as a test, ever sees this value -
 * config.get returns the registered default otherwise.
 */
export const DEFAULT_AMBIGUOUS_IMPORTS: Record<string, string> = {};

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
 * Turns Verse compiler messages into import suggestions, for both the quick-fix
 * menu and Optimize Imports.
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

    /** Every path written as `using { /Path }` in the text. */
    private extractUsingPaths(text: string): string[] {
        const paths: string[] = [];
        const pattern = new RegExp(PATTERNS.USING_PATH.source, "g");
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            paths.push(match[1]);
        }
        return paths;
    }

    /** Every path written as `(/Path:)`, the form used by "could be one of many types". */
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
     * The split normally falls before the last segment. An intermediate segment
     * that names a known asset class moves it earlier, since everything from
     * that class onward addresses members rather than modules.
     *
     * Null when the name is not a dotted identifier chain, or carries no module
     * part at all.
     *
     * @param fullName e.g. "MyGame.UI.UI_Widget.ClassName"
     */
    private splitModulePathAndClass(fullName: string): { modulePath: string; className: string } | null {
        // "Did you mean" captures raw sentence text, so trailing punctuation
        // ("Economy.Shop.") or prose ("to use Bar.Baz instead?") reaches this
        // point, and splitting those produces a plausible-looking but wrong
        // import.
        if (!QUALIFIED_NAME.test(fullName)) {
            logger.debug("ImportSuggestionExtractor", `Rejecting suggestion text that is not a dotted identifier chain: ${fullName}`);
            return null;
        }

        const parts = fullName.split(".");
        if (parts.length < 2) {
            return null;
        }

        // Backwards from the second-to-last segment: the last is always taken to
        // be the identifier being referenced, never a module.
        for (let i = parts.length - 2; i > 0; i--) {
            const segment = parts[i];

            if (this.assetsDigestParser?.isAssetClassName(segment)) {
                const modulePath = parts.slice(0, i).join(".");
                const className = parts[parts.length - 1];

                logger.debug("ImportSuggestionExtractor", `Found asset class '${segment}' in path '${fullName}'. Module: ${modulePath}, Class: ${className}`);

                return { modulePath, className };
            }
        }

        // No asset class in between: the last segment is the class and
        // everything before it the module.
        const lastDotIndex = fullName.lastIndexOf(".");
        return {
            modulePath: fullName.substring(0, lastDotIndex),
            className: fullName.substring(lastDotIndex + 1),
        };
    }

    /**
     * The importable candidates among a "Did you mean" option list, one option
     * per line. Non-importable entries are dropped rather than rejected, so a
     * list mixing importable and bare entries still yields the importable ones.
     */
    private candidatesFromOptionList(optionBlock: string): ImportCandidate[] {
        const options = optionBlock
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        logger.debug("ImportSuggestionExtractor", `Parsing ${options.length} suggestion options: ${options.join(", ")}`);

        const candidates: ImportCandidate[] = [];
        for (const option of options) {
            if (option.startsWith("/")) {
                candidates.push({ path: option, description: `Import from ${option}` });
                continue;
            }
            // A fully qualified name, "Module.ClassName" or
            // "Module.AssetClass.Member".
            const result = this.splitModulePathAndClass(option);
            if (result && result.modulePath) {
                candidates.push({ path: result.modulePath, description: `${result.className} from ${result.modulePath}` });
            } else {
                // A bare identifier, such as a local definition echoed in
                // the option list, carries no module path to import.
                logger.debug("ImportSuggestionExtractor", `Dropping non-importable multi-option entry: ${option}`);
            }
        }
        return candidates;
    }

    /**
     * The candidates of a message carrying both same-package suggestions and
     * external `using` suggestions, or null when it carries only one kind.
     *
     * The compiler joins the two lists inline, so the last same-package path
     * and the joiner share a line. Neither half parses while they are together:
     * the joined line fails QUALIFIED_NAME and the using lines are not options.
     */
    private parseMixedCandidates(errorMessage: string): ImportCandidate[] | null {
        const joiner = errorMessage.match(PATTERNS.MIXED_JOINER);
        if (!joiner || joiner.index === undefined) {
            return null;
        }

        const samePackageHalf = errorMessage.slice(0, joiner.index);
        const usingHalf = errorMessage.slice(joiner.index + joiner[0].length);

        // The single-suggestion form goes through the same option list as the
        // "any of" form, so one menu describes both halves the same way.
        const listed = samePackageHalf.match(PATTERNS.DID_YOU_MEAN_ANY) ?? samePackageHalf.match(PATTERNS.DID_YOU_MEAN_SINGLE);
        const candidates = listed ? this.candidatesFromOptionList(listed[1]) : [];

        // Covers both tails the joiner can introduce: "one of:" with a list, and
        // a bare "using { /Path }".
        for (const path of this.extractUsingPaths(usingHalf)) {
            candidates.push({ path, description: `Import from ${path}` });
        }

        logger.debug("ImportSuggestionExtractor", `Found ${candidates.length} mixed same-package and using candidates: ${candidates.map((candidate) => candidate.path).join(", ")}`);
        return candidates;
    }

    /**
     * The importable candidates offered by a message that lists several.
     *
     * Null and [] mean different things: null when no multi-option pattern
     * matched at all, [] when one matched but no option was importable, such as
     * a list of bare identifiers.
     *
     * The mixed pattern is tried first and stands in front of all three below,
     * because a non-null result never falls back into the cascade. A mixed
     * message also matches the same-package pattern, which would read the
     * joined tail as options and drop every candidate but the first.
     */
    private parseMultiOptionCandidates(errorMessage: string): ImportCandidate[] | null {
        const mixed = this.parseMixedCandidates(errorMessage);
        if (mixed !== null) {
            return mixed;
        }

        const match1 = errorMessage.match(PATTERNS.DID_YOU_MEAN_ANY);
        if (match1) {
            return this.candidatesFromOptionList(match1[1]);
        }

        const match2 = errorMessage.match(PATTERNS.FORGET_ONE_OF);
        if (match2) {
            const options = this.extractUsingPaths(match2[1]);
            logger.debug("ImportSuggestionExtractor", `Found ${options.length} multi-options (pattern 2): ${options.join(", ")}`);
            return options.map((path) => ({ path, description: `Import from ${path}` }));
        }

        const match3 = errorMessage.match(PATTERNS.IDENTIFIER_MANY_TYPES);
        if (match3) {
            const options = this.extractParenPaths(match3[1]);
            logger.debug("ImportSuggestionExtractor", `Found ${options.length} multi-options (pattern 3): ${options.join(", ")}`);
            return options.map((path) => ({ path, description: `Import from ${path}` }));
        }

        return null;
    }

    /**
     * The import candidate behind a "Did you mean Namespace.Component"
     * suggestion, or null when the suggestion carries no module path - a
     * single-segment name never produces an import.
     */
    private inferFromDidYouMean(errorMessage: string): ImportCandidate | null {
        const didYouMeanMatch = errorMessage.match(PATTERNS.DID_YOU_MEAN_SINGLE);
        if (!didYouMeanMatch) {
            return null;
        }
        const fullName = didYouMeanMatch[1].trim();
        const result = this.splitModulePathAndClass(fullName);
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

        const specificMatch = errorMessage.match(PATTERNS.UNKNOWN_WITH_SUGGESTION);
        if (specificMatch) {
            const identifierMatch = errorMessage.match(PATTERNS.UNKNOWN_IDENTIFIER);
            const name = identifierMatch ? identifierMatch[1] : specificMatch[1];
            return { kind: "singleImport", candidate: { path: specificMatch[1], description: `Import ${name} from ${specificMatch[1]}` } };
        }

        const forgetMatch = errorMessage.match(PATTERNS.FORGET_SINGLE);
        if (forgetMatch) {
            return { kind: "singleImport", candidate: { path: forgetMatch[1], description: `Standard import for ${forgetMatch[1]}` } };
        }

        // An unknown identifier with no inline path. The consumer decides how to
        // resolve it: configured mapping, digest lookup, or the inferred
        // "Did you mean" path.
        const unknownMatch = errorMessage.match(PATTERNS.UNKNOWN_IDENTIFIER);
        if (unknownMatch) {
            const inferred = this.inferFromDidYouMean(errorMessage);
            return { kind: "identifier", identifier: unknownMatch[1], inferred: inferred ?? undefined };
        }

        // A "Did you mean" with no unknown-identifier prefix in front of it.
        const inferred = this.inferFromDidYouMean(errorMessage);
        if (inferred) {
            return { kind: "singleImport", candidate: inferred };
        }

        return { kind: "none" };
    }

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
     * The import suggestions the digest files offer for an identifier. Empty
     * unless `experimental.useDigestFiles` is on, and empty rather than
     * throwing when the lookup fails.
     *
     * Always high confidence: the lookup matches the identifier exactly, so an
     * entry it returns declares the name the compiler could not resolve.
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
                const description = `${entry.type} from ${entry.modulePath}`;

                suggestions.push(this.createImportSuggestion(importStatement, "digest_lookup", "high", description));
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
     * Every import suggestion a single compiler message supports, ambiguous
     * ones included - the quick-fix menu is where the user picks between them.
     *
     * An unknown identifier is resolved in a fixed order: a configured
     * ambiguous mapping first, then the digest lookup, then the path inferred
     * from a "Did you mean". The order is the precedence, most specific first.
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
                if (ambiguousImportMappings[classification.identifier]) {
                    const preferredPath = ambiguousImportMappings[classification.identifier];
                    const importStatement = this.formatter.formatImportStatement(preferredPath, preferDotSyntax);
                    logger.debug("ImportSuggestionExtractor", `Using configured path for ambiguous class ${classification.identifier}: ${importStatement}`);
                    return [this.createImportSuggestion(importStatement, "error_message", "high", `Configured import for ${classification.identifier}`)];
                }

                const digestSuggestions = await this.lookupIdentifierInDigest(classification.identifier);
                if (digestSuggestions.length > 0) {
                    logger.debug("ImportSuggestionExtractor", `Found digest-based suggestions for unknown identifier: ${classification.identifier}`);
                    return digestSuggestions;
                }

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
     * The unambiguous import paths across a set of diagnostics, deduplicated,
     * with the line each diagnostic was reported on, for the Optimize Imports
     * command.
     *
     * The lines are kept because this loop is the last place they exist: a path
     * carries no trace of the diagnostic that asked for it, and placement needs
     * that trace to read a pinned import as the consumer a new import was added
     * for. Both halves come out of one pass so they cannot disagree about which
     * diagnostic named which path.
     *
     * Ambiguous messages are left out rather than resolved: they need a user
     * choice, which belongs to the quick-fix menu. A command that adds imports
     * in bulk has nobody to ask.
     */
    extractImportsFromDiagnostics(diagnostics: vscode.Diagnostic[]): MissingImports {
        logger.debug("ImportSuggestionExtractor", `Extracting imports from ${diagnostics.length} diagnostics`);

        const suggestedPaths = new Set<string>();
        // Concatenated where two diagnostics name one path: a second diagnostic
        // asking for the same import is further evidence, not a replacement for
        // the first.
        const diagnosticLinesByPath = new Map<string, number[]>();
        const record = (path: string, diagnostic: vscode.Diagnostic): void => {
            suggestedPaths.add(path);
            diagnosticLinesByPath.set(path, [...(diagnosticLinesByPath.get(path) ?? []), diagnostic.range.start.line]);
        };

        for (const diagnostic of diagnostics) {
            const classification = this.classifyMessage(diagnostic.message);

            switch (classification.kind) {
                case "singleImport":
                    record(classification.candidate.path, diagnostic);
                    logger.debug("ImportSuggestionExtractor", `Found path: ${classification.candidate.path}`);
                    break;

                case "identifier":
                    if (classification.inferred) {
                        record(classification.inferred.path, diagnostic);
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

        const paths = Array.from(suggestedPaths);
        logger.debug("ImportSuggestionExtractor", `Extracted ${paths.length} unique import paths from diagnostics`);
        return { paths, diagnosticLinesByPath };
    }
}

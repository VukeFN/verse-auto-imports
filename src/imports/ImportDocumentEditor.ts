import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportFormatter } from "./ImportFormatter";
import { scanModuleImports, ScannedImport } from "./ImportScanner";

/** Represents a contiguous block of import statements in the document. */
interface ImportBlock {
    start: number;
    end: number;
    imports: ScannedImport[];
}

/** The line ending a document is written with. */
export type LineEnding = "\r\n" | "\n";

/** Splits text into lines without keeping the carriage return of a CRLF pair. */
const LINE_SPLIT = /\r?\n/;

/**
 * Detects the dominant line ending of a text, or null when it has no line
 * break at all and therefore carries no evidence either way.
 *
 * Every writer joins with this rather than a hardcoded "\n": on Windows
 * `files.eol` resolves to CRLF, so joining with LF produces a mixed-ending
 * buffer and, because the rebuilt text can then never equal the original,
 * defeats the `organized === text` short-circuit in organizeImports.
 *
 * The text is the authority, not TextDocument.eol: the two can disagree, and
 * only matching what is actually in the buffer keeps a rebuild idempotent.
 */
export function detectEol(text: string): LineEnding | null {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    if (crlf === 0 && lf === 0) {
        return null;
    }
    // A tie means the text is already mixed; LF is the portable choice.
    return crlf > lf ? "\r\n" : "\n";
}

/** The line ending VS Code writes new lines with in this document. */
function documentEol(document: vscode.TextDocument): LineEnding {
    return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

/**
 * The line ending every write into this document must use. One home for the
 * policy so the writers cannot drift apart on it.
 */
function resolveEol(document: vscode.TextDocument, text: string): LineEnding {
    return detectEol(text) ?? documentEol(document);
}

/**
 * Handles all document modifications for imports.
 */
export class ImportDocumentEditor {
    private readonly formatter: ImportFormatter;

    constructor(
        private outputChannel: vscode.OutputChannel,
        formatter: ImportFormatter,
    ) {
        this.formatter = formatter;
    }

    /**
     * Creates an edit to replace an import block with combined and formatted imports.
     */
    private createBlockReplacementEdit(
        edit: vscode.WorkspaceEdit,
        document: vscode.TextDocument,
        block: ImportBlock,
        newPaths: string[],
        preferDotSyntax: boolean,
        sortAlphabetically: boolean,
        eol: LineEnding,
    ): void {
        // Get existing paths in this block for combined sorting
        const existingBlockPaths = block.imports.map((imp) => imp.path);

        let combinedPaths = [...existingBlockPaths, ...newPaths];
        if (sortAlphabetically) {
            combinedPaths = this.formatter.sortImportsByRank(combinedPaths);
        }

        // Format all imports for this block
        const formattedImports = combinedPaths.map((path) => this.formatter.formatImportStatement(path, preferDotSyntax));

        // Replace the entire block
        edit.replace(document.uri, new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0)), formattedImports.join(eol) + eol);
    }

    /**
     * Extracts existing import statements from a document. Indented pairs
     * (`using:` plus the path line) are returned joined as a single statement.
     */
    extractExistingImports(document: vscode.TextDocument): string[] {
        logger.debug("ImportDocumentEditor", "Extracting existing imports from document");
        const lines = document.getText().split(LINE_SPLIT);
        const imports = new Set<string>();

        for (const imp of scanModuleImports(lines)) {
            const statement = lines
                .slice(imp.startLine, imp.endLine + 1)
                .map((line) => line.trim())
                .join(" ");
            logger.trace("ImportDocumentEditor", `Found import: ${statement}`);
            imports.add(statement);
        }

        logger.debug("ImportDocumentEditor", `Extracted ${imports.size} existing imports`);
        return Array.from(imports);
    }

    /**
     * Adds import statements to a document.
     */
    async addImportsToDocument(document: vscode.TextDocument, importStatements: string[]): Promise<boolean> {
        logger.info("ImportDocumentEditor", `Adding ${importStatements.length} import statements to document`);

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax = config.get<string>("behavior.importSyntax", "curly") === "dot";
        const preserveImportLocations = config.get<boolean>("behavior.preserveImportLocations", true);
        const sortAlphabetically = config.get<boolean>("behavior.sortImportsAlphabetically", true);
        const importGrouping = config.get<string>("behavior.importGrouping", "none");

        logger.debug("ImportDocumentEditor", `Import statements received:${preserveImportLocations ? " (locations will be preserved)" : ""} Sort: ${sortAlphabetically} Grouping: ${importGrouping}`);
        importStatements.forEach((statement) => {
            logger.debug("ImportDocumentEditor", `- ${statement}`);
        });

        const text = document.getText();
        const eol = resolveEol(document, text);
        const lines = text.split(LINE_SPLIT);
        const scannedImports = scanModuleImports(lines);

        const importBlocks: ImportBlock[] = [];
        for (const imp of scannedImports) {
            logger.debug("ImportDocumentEditor", `Found existing import at line ${imp.startLine}: ${imp.path}`);

            const lastBlock = importBlocks[importBlocks.length - 1];
            if (lastBlock && imp.startLine === lastBlock.end + 1) {
                // Only extend block if import immediately follows (no gap)
                lastBlock.end = imp.endLine;
                lastBlock.imports.push(imp);
            } else {
                // Any gap creates a new block
                importBlocks.push({ start: imp.startLine, end: imp.endLine, imports: [imp] });
            }
        }

        logger.debug("ImportDocumentEditor", `Found ${scannedImports.length} existing imports in ${importBlocks.length} blocks`);

        const existingPaths = new Set<string>(scannedImports.map((imp) => imp.path));

        const newImportPaths = new Set<string>();
        importStatements.forEach((imp) => {
            const path = this.formatter.extractPathFromImport(imp);
            if (path && !existingPaths.has(path)) {
                logger.debug("ImportDocumentEditor", `New import needed: ${path}`);
                newImportPaths.add(path);
            }
        });

        if (newImportPaths.size === 0) {
            logger.debug("ImportDocumentEditor", "No new imports needed, skipping update");
            return true;
        }

        const edit = new vscode.WorkspaceEdit();

        if (preserveImportLocations) {
            // Check if existing imports are grouped (2+ blocks with gap between them)
            const hasGrouping =
                importGrouping !== "none" &&
                importBlocks.length >= 2 &&
                importBlocks.some((block, i) => {
                    if (i === 0) return false;
                    // Check if there's a gap between this block and the previous one
                    return block.start > importBlocks[i - 1].end + 1;
                });

            if (hasGrouping && importBlocks.length >= 2) {
                // Analyze existing blocks to determine which is digest and which is local
                let digestBlockIndex = -1;
                let localBlockIndex = -1;

                importBlocks.forEach((block, index) => {
                    const blockPaths = block.imports.map((imp) => imp.path);
                    const hasDigest = blockPaths.some((path) => this.formatter.isDigestImport(path));
                    const hasLocal = blockPaths.some((path) => !this.formatter.isDigestImport(path));

                    // Determine block type based on majority
                    if (hasDigest && !hasLocal) {
                        digestBlockIndex = index;
                    } else if (hasLocal && !hasDigest) {
                        localBlockIndex = index;
                    }
                });

                // Separate new imports into digest and local
                const newDigestPaths: string[] = [];
                const newLocalPaths: string[] = [];

                for (const path of newImportPaths) {
                    if (this.formatter.isDigestImport(path)) {
                        newDigestPaths.push(path);
                    } else {
                        newLocalPaths.push(path);
                    }
                }

                // Add digest imports to digest block
                if (newDigestPaths.length > 0 && digestBlockIndex >= 0) {
                    this.createBlockReplacementEdit(edit, document, importBlocks[digestBlockIndex], newDigestPaths, preferDotSyntax, sortAlphabetically, eol);
                }

                // Add local imports to local block
                if (newLocalPaths.length > 0 && localBlockIndex >= 0) {
                    this.createBlockReplacementEdit(edit, document, importBlocks[localBlockIndex], newLocalPaths, preferDotSyntax, sortAlphabetically, eol);
                }

                // Handle imports that don't have a matching block
                const unhandledDigest = digestBlockIndex < 0 ? newDigestPaths : [];
                const unhandledLocal = localBlockIndex < 0 ? newLocalPaths : [];
                const unhandledPaths = [...unhandledDigest, ...unhandledLocal];

                if (unhandledPaths.length > 0) {
                    const unhandledImports = this.formatter.groupAndFormatImports(unhandledPaths, preferDotSyntax, sortAlphabetically, importGrouping);

                    // Add unhandled imports at the appropriate position
                    if (importBlocks.length > 0) {
                        edit.insert(document.uri, new vscode.Position(importBlocks[importBlocks.length - 1].end + 1, 0), unhandledImports.join(eol) + eol);
                    } else {
                        edit.insert(document.uri, new vscode.Position(0, 0), unhandledImports.join(eol) + eol + eol);
                    }
                }
            } else {
                // Either no existing grouping or need to create initial groups
                if (importGrouping !== "none" && existingPaths.size > 0) {
                    // We have existing imports but no grouping - reorganize everything into groups
                    const allPaths = new Set<string>([...existingPaths, ...newImportPaths]);
                    const allImportsArray = Array.from(allPaths);
                    const groupedImports = this.formatter.groupAndFormatImports(allImportsArray, preferDotSyntax, sortAlphabetically, importGrouping);

                    if (importBlocks.length > 0) {
                        // Replace the first existing block in place so it stays at its
                        // original location rather than relocating to the top of the file.
                        // Delete any additional blocks defensively (by construction this
                        // branch only sees one block when grouping != "none", since 2+
                        // gapped blocks are handled by the hasGrouping branch above).
                        const firstBlock = importBlocks[0];
                        edit.replace(document.uri, new vscode.Range(new vscode.Position(firstBlock.start, 0), new vscode.Position(firstBlock.end + 1, 0)), groupedImports.join(eol) + eol);

                        for (let i = importBlocks.length - 1; i >= 1; i--) {
                            const block = importBlocks[i];
                            edit.delete(document.uri, new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0)));
                        }
                    } else {
                        // No existing imports - insert grouped imports at the top
                        edit.insert(document.uri, new vscode.Position(0, 0), groupedImports.join(eol) + eol + eol);
                    }
                } else {
                    // No grouping or no existing imports - use original behavior
                    const newImportPathsArray = Array.from(newImportPaths);

                    if (sortAlphabetically && importBlocks.length > 0) {
                        // Merge the new imports into the first existing block in
                        // place so the combined block is rank-ordered (bare
                        // module providers before the dotted consumers that
                        // depend on them). Appending the new imports after the
                        // block instead could place a provider such as
                        // `using { Features }` below a consumer such as
                        // `using { Economy.Shop }`, which breaks Verse's
                        // top-down using resolution.
                        this.createBlockReplacementEdit(edit, document, importBlocks[0], newImportPathsArray, preferDotSyntax, true, eol);
                    } else {
                        // Sorting off or no existing block: keep the original
                        // append-in-place behavior and leave existing lines
                        // untouched.
                        const newImports = this.formatter.groupAndFormatImports(newImportPathsArray, preferDotSyntax, sortAlphabetically, importGrouping);

                        if (importBlocks.length > 0 && importBlocks[0].start === 0) {
                            edit.insert(document.uri, new vscode.Position(importBlocks[0].end + 1, 0), newImports.join(eol) + eol);
                        } else {
                            edit.insert(document.uri, new vscode.Position(0, 0), newImports.join(eol) + eol + eol);
                        }
                    }
                }
            }
        } else {
            // Consolidate all imports at the top
            const allPaths = new Set<string>([...existingPaths, ...newImportPaths]);
            const allImportsArray = Array.from(allPaths);

            // Use the new grouping method for all imports
            const formattedImports = this.formatter.groupAndFormatImports(allImportsArray, preferDotSyntax, sortAlphabetically, importGrouping);

            // Insert imports at top with minimal spacing (will be fixed by ensureEmptyLinesAfterImports)
            const importsText = formattedImports.join(eol) + eol;
            edit.insert(document.uri, new vscode.Position(0, 0), importsText);

            // Remove existing import blocks (in reverse order to maintain line numbers)
            for (let i = importBlocks.length - 1; i >= 0; i--) {
                const block = importBlocks[i];
                edit.delete(document.uri, new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0)));
            }
        }

        try {
            const success = await vscode.workspace.applyEdit(edit);
            logger.info("ImportDocumentEditor", success ? "Successfully updated imports in document" : "Failed to update imports in document");

            // After adding imports, ensure proper spacing
            if (success) {
                await this.ensureEmptyLinesAfterImports(document);
            }

            return success;
        } catch (error) {
            logger.error("ImportDocumentEditor", `Error updating imports: ${error}`, error);
            return false;
        }
    }

    /**
     * Computes the document text with every module import consolidated into
     * one organized block at the top: existing imports plus additional paths,
     * deduplicated, grouped, sorted, and formatted per the given options.
     * Handles all three Verse import styles, including the indented pair
     * (`using:` plus the indented path on the next line). Local-scope `using`
     * statements are left where they are. Returns null when the document has
     * no module imports and no additional paths (nothing to organize).
     *
     * The result keeps the text's own line ending, so rebuilding an already
     * organized document reproduces it byte for byte and organizeImports can
     * skip the edit.
     */
    buildOrganizedContent(
        text: string,
        additionalPaths: string[],
        options: {
            preferDotSyntax: boolean;
            sortAlphabetically: boolean;
            importGrouping: string;
            /** Line ending to use when the text has no line break to detect one from. */
            fallbackEol?: LineEnding;
        },
    ): string | null {
        const eol = detectEol(text) ?? options.fallbackEol ?? "\n";
        const lines = text.split(LINE_SPLIT);
        const scannedImports = scanModuleImports(lines);

        const paths = scannedImports.map((imp) => imp.path);
        const importLines = new Set<number>();
        for (const imp of scannedImports) {
            for (let line = imp.startLine; line <= imp.endLine; line++) {
                importLines.add(line);
            }
        }
        const body = lines.filter((_, index) => !importLines.has(index));

        const extraPaths = additionalPaths.map((p) => p.trim()).filter((p) => p.length > 0);
        if (paths.length === 0 && extraPaths.length === 0) {
            return null;
        }

        const uniquePaths = Array.from(new Set([...paths, ...extraPaths]));
        const formatted = this.formatter.groupAndFormatImports(uniquePaths, options.preferDotSyntax, options.sortAlphabetically, options.importGrouping);

        // Drop blank lines the removed imports left at the top; the gap after
        // the block is normalized by ensureEmptyLinesAfterImports afterwards.
        let firstContent = 0;
        while (firstContent < body.length && body[firstContent].trim() === "") {
            firstContent++;
        }
        const remainingBody = body.slice(firstContent);

        if (remainingBody.length === 0) {
            return formatted.join(eol) + eol;
        }

        return [...formatted, "", ...remainingBody].join(eol);
    }

    /**
     * Rebuilds the document's import block in a single atomic edit: existing
     * imports plus the given additional paths, deduplicated, grouped, sorted,
     * and written in the preferred syntax at the top of the file. Unlike
     * addImportsToDocument this reorganizes even when nothing new is added.
     */
    async organizeImports(document: vscode.TextDocument, additionalPaths: string[]): Promise<boolean> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax = config.get<string>("behavior.importSyntax", "curly") === "dot";
        const sortAlphabetically = config.get<boolean>("behavior.sortImportsAlphabetically", true);
        const importGrouping = config.get<string>("behavior.importGrouping", "none");

        const text = document.getText();
        const organized = this.buildOrganizedContent(text, additionalPaths, {
            preferDotSyntax,
            sortAlphabetically,
            importGrouping,
            fallbackEol: documentEol(document),
        });

        if (organized === null || organized === text) {
            logger.debug("ImportDocumentEditor", "No import changes needed by organize");
            return true;
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
        edit.replace(document.uri, fullRange, organized);

        try {
            const success = await vscode.workspace.applyEdit(edit);
            logger.info("ImportDocumentEditor", success ? "Organized imports in document" : "Failed to organize imports");

            if (success) {
                await this.ensureEmptyLinesAfterImports(document);
            }

            return success;
        } catch (error) {
            logger.error("ImportDocumentEditor", `Error organizing imports: ${error}`, error);
            return false;
        }
    }

    /**
     * Ensures the proper number of empty lines exists after the last import statement.
     * This method is called when saving files, adding imports, or optimizing imports.
     */
    async ensureEmptyLinesAfterImports(document: vscode.TextDocument): Promise<boolean> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const emptyLinesAfterImports = config.get<number>("behavior.emptyLinesAfterImports", 1);

        logger.debug("ImportDocumentEditor", `Ensuring ${emptyLinesAfterImports} empty lines after imports`);

        const text = document.getText();
        const eol = resolveEol(document, text);
        const lines = text.split(LINE_SPLIT);

        // Find the last file-level import (module imports only: not local-scope
        // using, and not module-scoped imports inside module bodies)
        const scannedImports = scanModuleImports(lines);
        const lastImportLine = scannedImports.length > 0 ? scannedImports[scannedImports.length - 1].endLine : -1;

        // If no imports found or file only has imports, nothing to do
        if (lastImportLine === -1 || lastImportLine === lines.length - 1) {
            logger.debug("ImportDocumentEditor", "No imports found or file ends with imports, skipping spacing adjustment");
            return true;
        }

        // Count existing empty lines after the last import
        let existingEmptyLines = 0;
        for (let i = lastImportLine + 1; i < lines.length; i++) {
            if (lines[i].trim() === "") {
                existingEmptyLines++;
            } else {
                break;
            }
        }

        // Check if there's non-import content after the imports
        let hasContentAfterImports = false;
        for (let i = lastImportLine + 1; i < lines.length; i++) {
            if (lines[i].trim() !== "") {
                hasContentAfterImports = true;
                break;
            }
        }

        // Only adjust if there's content after imports
        if (!hasContentAfterImports) {
            logger.debug("ImportDocumentEditor", "No content after imports, skipping spacing adjustment");
            return true;
        }

        // Calculate adjustment needed
        const lineDifference = emptyLinesAfterImports - existingEmptyLines;

        if (lineDifference === 0) {
            logger.debug("ImportDocumentEditor", `Already has ${emptyLinesAfterImports} empty lines after imports`);
            return true;
        }

        const edit = new vscode.WorkspaceEdit();

        if (lineDifference > 0) {
            // Need to add empty lines
            const newLines = eol.repeat(lineDifference);
            const insertPosition = new vscode.Position(lastImportLine + 1, 0);
            edit.insert(document.uri, insertPosition, newLines);
            logger.info("ImportDocumentEditor", `Adding ${lineDifference} empty lines after imports`);
        } else {
            // Need to remove empty lines
            const linesToRemove = Math.abs(lineDifference);
            const startLine = lastImportLine + 1;
            const endLine = Math.min(startLine + linesToRemove, lines.length);
            const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, 0));
            edit.delete(document.uri, range);
            logger.info("ImportDocumentEditor", `Removing ${linesToRemove} empty lines after imports`);
        }

        try {
            const success = await vscode.workspace.applyEdit(edit);
            logger.info("ImportDocumentEditor", success ? "Successfully adjusted spacing after imports" : "Failed to adjust spacing");
            return success;
        } catch (error) {
            logger.error("ImportDocumentEditor", `Error adjusting spacing: ${error}`, error);
            return false;
        }
    }
}

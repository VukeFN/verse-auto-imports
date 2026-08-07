import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportFormatter } from "./ImportFormatter";
import { allModuleImportPaths, classifyLines, LineClassification, rewritableImports, scanModuleImports, ScannedImport } from "./ImportScanner";

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
 * The end, exclusive, of the run of comment and blank lines a file opens with.
 *
 * That run is the file header - a licence, an attribution, a description of
 * what the file is - and it belongs above the import block rather than below
 * it. Rebuilding the block at line 0 pushed the header into the middle of the
 * file, which is the one place a header must never be.
 *
 * Position identifies it, never content: the first line carrying code ends the
 * header, whether that line is an import or anything else. A header therefore
 * stays put even in a file whose imports sit further down among code, where
 * everything else is hoisted past it.
 *
 * A run of nothing but blank lines is not a header: it describes nothing, and
 * it is dropped here as it always was.
 *
 * The opening run wins over the annotation rule below, so a comment on line 0
 * written against the first import stays at the top of the block rather than
 * following that import down through a sort. Line 0 is ambiguous - a file
 * header and a first-import annotation are written identically - and of the
 * two readings only this one leaves the comment where the author put it. The
 * other relocates a licence into the middle of the import block, which is the
 * defect this whole change exists to remove.
 */
function headerLineCount(classifications: LineClassification[]): number {
    let end = 0;
    while (end < classifications.length && classifications[end].kind !== "code") {
        end++;
    }
    return classifications.slice(0, end).some((classification) => classification.kind === "comment") ? end : 0;
}

/**
 * The first line of the comment run written directly above an import, which is
 * the annotation of that import and has to travel with it. Returns the
 * import's own start line when nothing is attached.
 *
 * A blank line ends the run: a comment separated from an import by one is
 * loose prose about the region, not a label for the statement below it. So
 * does `firstAttachableLine`, the end of the header - see headerLineCount for
 * why the file's opening comment run is read as a header rather than as the
 * first import's annotation.
 */
function attachedCommentStart(importStartLine: number, classifications: LineClassification[], firstAttachableLine: number): number {
    let start = importStartLine;
    while (start > firstAttachableLine && classifications[start - 1].kind === "comment") {
        start--;
    }

    // Never carry away half a comment. Where the run begins inside one opened
    // above it - a `<# ... #>` whose opener is an import line that cannot
    // move, or the indented body of a `<#>` marker the run does not reach -
    // moving those lines would leave the opener behind to swallow whatever
    // followed it and strand the rest somewhere it no longer reads as comment.
    while (start < importStartLine && classifications[start].continuesCommentAbove) {
        start++;
    }

    return start;
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
     * The comment trailing each import, keyed on the statement a rebuild emits
     * for its path.
     *
     * Keyed on the formatted statement rather than on a line, because that is
     * the only handle a writer still has once it has sorted and grouped a list
     * of paths - the same reason buildOrganizedContent keys the comments
     * written *above* an import that way.
     *
     * Deduplication keeps one statement for a repeated path, so the comments of
     * its several occurrences are concatenated rather than replaced: keeping
     * only the last would delete text the author wrote. They stay on one line,
     * which is where they were, and a `#` comment runs to the end of it.
     */
    private trailingCommentsByStatement(scannedImports: ScannedImport[], preferDotSyntax: boolean): Map<string, string> {
        const byStatement = new Map<string, string>();
        for (const imp of scannedImports) {
            // An anchored import has a trailing comment like any other, and its
            // is the marker that anchors it. Restoring that onto a rebuilt line
            // is what puts the marker somewhere it was not written, so it is
            // refused here rather than only by every caller passing a filtered
            // list. Every caller does today; one that forgot would resurrect a
            // defect this branch has already shipped once.
            if (!imp.trailingComment || imp.anchorsCommentBelow) {
                continue;
            }
            const statement = this.formatter.formatImportStatement(imp.path, preferDotSyntax);
            const existing = byStatement.get(statement);
            byStatement.set(statement, existing ? `${existing} ${imp.trailingComment}` : imp.trailingComment);
        }
        return byStatement;
    }

    /**
     * Puts an import's trailing comment back on the statement rebuilt from its
     * path. A group separator groupAndFormatImports emits is left alone: no
     * path formats to one, so none is ever a key.
     */
    private withTrailingComment(statement: string, trailingByStatement: Map<string, string>): string {
        const trailing = trailingByStatement.get(statement);
        return trailing ? `${statement} ${trailing}` : statement;
    }

    /** withTrailingComment over a whole rebuilt block. */
    private withTrailingComments(statements: string[], trailingByStatement: Map<string, string>): string[] {
        return statements.map((statement) => this.withTrailingComment(statement, trailingByStatement));
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

        // Format all imports for this block, restoring the comment each
        // existing one trailed its line with.
        const formattedImports = this.withTrailingComments(
            combinedPaths.map((path) => this.formatter.formatImportStatement(path, preferDotSyntax)),
            this.trailingCommentsByStatement(block.imports, preferDotSyntax),
        );

        // Replace the entire block
        edit.replace(document.uri, new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0)), formattedImports.join(eol) + eol);
    }

    /**
     * Chooses which existing import block a new path must be merged into so the
     * rank ordering holds across the whole file rather than only inside one
     * block.
     *
     * createBlockReplacementEdit rank-sorts the block it rewrites, so it orders
     * a provider above its consumer only while both sit in that same block. Any
     * blank line between imports starts a second block, so always merging into
     * `importBlocks[0]` could place a new `using { Economy.Shop }` above the
     * `using { Features }` that brings `Economy` into scope - the breakage the
     * rank sort exists to prevent.
     *
     * Two bounds decide the block, read from the same ranks sortImportsByRank
     * compares:
     * - the last block holding an import that belongs above the new one: a
     *   lower rank, or another bare reference, whose relative order is semantic
     *   and which the sort likewise keeps ahead of a newly added one.
     * - the first block holding an import the new one belongs above: a higher
     *   rank. This is what keeps a bare provider above the dotted consumer it
     *   was added for, even when that consumer is in an earlier block.
     *
     * The lower bound wins where both apply, keeping the new import as high in
     * the file as is safe, and the upper bound caps it where the two disagree.
     * With no lower bound the first block is used, which is also where an
     * absolute path belongs: it needs nothing in scope, so no import has to
     * precede it.
     */
    private selectTargetBlockIndex(importBlocks: ImportBlock[], path: string): number {
        const rank = this.formatter.importRank(path);

        let lowerBound = -1;
        let upperBound = -1;
        importBlocks.forEach((block, index) => {
            const ranks = block.imports.map((imp) => this.formatter.importRank(imp.path));
            if (ranks.some((existing) => existing < rank || (existing === rank && rank === 1))) {
                lowerBound = index;
            }
            if (upperBound === -1 && ranks.some((existing) => existing > rank)) {
                upperBound = index;
            }
        });

        if (lowerBound === -1) {
            return 0;
        }
        return upperBound !== -1 && upperBound < lowerBound ? upperBound : lowerBound;
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
        for (const imp of rewritableImports(scannedImports)) {
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

        // Existence is judged from every import, including one anchored by a
        // comment marker: it is imported, so nothing needs adding for it.
        const existingPaths = new Set<string>(scannedImports.map((imp) => imp.path));
        // Relocation is judged only from the movable ones. Re-emitting an
        // anchored path at the top while its own line necessarily stays put
        // would duplicate the import rather than move it.
        const relocatablePaths = new Set<string>(rewritableImports(scannedImports).map((imp) => imp.path));

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
                    const allPaths = new Set<string>([...relocatablePaths, ...newImportPaths]);
                    const allImportsArray = Array.from(allPaths);
                    const groupedImports = this.withTrailingComments(
                        this.formatter.groupAndFormatImports(allImportsArray, preferDotSyntax, sortAlphabetically, importGrouping),
                        this.trailingCommentsByStatement(rewritableImports(scannedImports), preferDotSyntax),
                    );

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
                        // Merge each new import into an existing block in place
                        // so the combined block is rank-ordered (bare module
                        // providers before the dotted consumers that depend on
                        // them). Appending the new imports after the block
                        // instead could place a provider such as
                        // `using { Features }` below a consumer such as
                        // `using { Economy.Shop }`, which breaks Verse's
                        // top-down using resolution.
                        //
                        // Which block each import joins is a whole-file
                        // decision, not always the first one: rank-sorting one
                        // block orders the new import against that block alone,
                        // which is how a consumer ended up above its provider in
                        // another block (see selectTargetBlockIndex).
                        const pathsByBlock = new Map<number, string[]>();
                        for (const path of newImportPathsArray) {
                            const index = this.selectTargetBlockIndex(importBlocks, path);
                            const targetPaths = pathsByBlock.get(index);
                            if (targetPaths) {
                                targetPaths.push(path);
                            } else {
                                pathsByBlock.set(index, [path]);
                            }
                        }

                        // Blocks are disjoint, so the replacements never overlap.
                        for (const index of [...pathsByBlock.keys()].sort((a, b) => a - b)) {
                            this.createBlockReplacementEdit(edit, document, importBlocks[index], pathsByBlock.get(index)!, preferDotSyntax, true, eol);
                        }
                    } else {
                        // Sorting off or no existing block: keep the original
                        // append-in-place behavior and leave existing lines
                        // untouched.
                        const newImports = this.formatter.groupAndFormatImports(newImportPathsArray, preferDotSyntax, sortAlphabetically, importGrouping);

                        if (importBlocks.length > 0) {
                            // After the last import block, not the first: with
                            // sorting off nothing reorders a block afterwards,
                            // so any earlier position could leave a new import
                            // above one that has to stay above it.
                            //
                            // Wherever that block sits, not only when it starts
                            // at line 0. A file whose imports open below a
                            // licence header has its first block at a later
                            // line, and inserting at line 0 there put the new
                            // import above the header and left two disconnected
                            // import regions behind.
                            const lastBlock = importBlocks[importBlocks.length - 1];
                            if (lastBlock.end + 1 < document.lineCount) {
                                edit.insert(document.uri, new vscode.Position(lastBlock.end + 1, 0), newImports.join(eol) + eol);
                            } else {
                                // The block ends a document with no trailing
                                // newline, so the line after it does not exist.
                                // VS Code clamps a position past the end onto
                                // the end of the last line, which would splice
                                // the new statement onto the last import and
                                // leave one unreadable line where two belong.
                                edit.insert(document.uri, document.lineAt(lastBlock.end).range.end, eol + newImports.join(eol));
                            }
                        } else {
                            edit.insert(document.uri, new vscode.Position(0, 0), newImports.join(eol) + eol + eol);
                        }
                    }
                }
            }
        } else {
            // Consolidate all imports at the top
            const allPaths = new Set<string>([...relocatablePaths, ...newImportPaths]);
            const allImportsArray = Array.from(allPaths);

            // Use the new grouping method for all imports
            const formattedImports = this.withTrailingComments(
                this.formatter.groupAndFormatImports(allImportsArray, preferDotSyntax, sortAlphabetically, importGrouping),
                this.trailingCommentsByStatement(rewritableImports(scannedImports), preferDotSyntax),
            );

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
     * Comments keep the position they were written in relative to the code
     * they describe: the file's opening comment run stays above the block (see
     * headerLineCount), and a comment written directly above an import travels
     * with that import wherever the sort puts it (see attachedCommentStart).
     *
     * A path an anchored import already provides is not written into the block
     * a second time, whether it arrives as an additional path or as a second
     * live import in the file. The live one is removed, together with the
     * comments written for it - they annotate a statement that no longer
     * exists. That removal happens only in a file whose every module import is
     * an absolute path, because any other import could be resolving its own
     * first segment against the copy being removed; see the withholdIsSafe
     * check.
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
        // An import anchored by a comment marker is neither hoisted nor
        // removed from the body: its line stays exactly where it is, and the
        // rest of the file is organized around it. It is still an import,
        // though, so an additional path it already covers must not be written
        // out a second time - that would duplicate it rather than move it.
        const allImports = scanModuleImports(lines);
        const movableImports = rewritableImports(allImports);
        const anchoredPaths = new Set(allImports.filter((imp) => imp.anchorsCommentBelow).map((imp) => imp.path));

        const extraPaths = additionalPaths.map((p) => p.trim()).filter((p) => p.length > 0 && !anchoredPaths.has(p));

        // Module imports have file scope, so the names an anchored import brings
        // in are available to code anywhere in the file, however far down its
        // line sits. A live import of the same path is therefore redundant for
        // code, and writing it into the block would leave the file importing the
        // path twice rather than moving it. The live one is still hoisted below,
        // which is what removes it from the body - only its statement is
        // withheld, along with the comments written for it, which annotate a
        // statement that no longer exists.
        //
        // Withholding it is only safe when no `using` in the file could resolve
        // against it. File scope governs what code can see, but a `using`
        // resolves its own path top-down: a path that is not absolute needs its
        // first segment already in scope above it, which is why sorting ranks
        // them (see ImportFormatter.sortImportsByRank, and the defects behind
        // it). The anchored line ends up below the rebuilt block, so withholding
        // the copy above it can strand such a path - in the block, or further
        // down the body where scanModuleImports does not even look, as in a
        // module-definition body.
        //
        // So this asks the whole file, at every indentation, and withholds only
        // where every module import in it is absolute. An absolute path needs
        // nothing in scope, so no import anywhere can be depending on the copy
        // being removed. That declines to tidy a file mixing bare or dotted
        // imports, which is the safe direction: the duplicate it leaves is legal
        // Verse, and a stranded provider is a file that stops compiling.
        const withholdIsSafe = [...allModuleImportPaths(lines), ...extraPaths].every((path) => this.formatter.importRank(path) === 0);
        const blockImports = withholdIsSafe ? movableImports.filter((imp) => !anchoredPaths.has(imp.path)) : movableImports;

        const paths = blockImports.map((imp) => imp.path);
        // Keyed on the unfiltered set: a file whose only rewritable import is
        // such a duplicate still has work to do, and returning null here would
        // leave the document - and the duplicate - untouched.
        if (movableImports.length === 0 && extraPaths.length === 0) {
            return null;
        }

        const classifications = classifyLines(lines);
        const headerEnd = headerLineCount(classifications);

        // Every line the rebuilt block accounts for: the import statements
        // themselves, and the comment lines written above them, which are part
        // of the statement they annotate rather than of the body.
        const hoistedLines = new Set<number>();
        const commentsByPath = new Map<string, string[]>();
        for (const imp of movableImports) {
            for (let line = imp.startLine; line <= imp.endLine; line++) {
                hoistedLines.add(line);
            }

            const commentStart = attachedCommentStart(imp.startLine, classifications, headerEnd);
            if (commentStart === imp.startLine) {
                continue;
            }

            for (let line = commentStart; line < imp.startLine; line++) {
                hoistedLines.add(line);
            }
            // Deduplication keeps one statement for a repeated path, so its
            // comments are concatenated rather than replaced: writing only the
            // last one would delete text the author wrote.
            commentsByPath.set(imp.path, [...(commentsByPath.get(imp.path) ?? []), ...lines.slice(commentStart, imp.startLine)]);
        }

        const header = lines.slice(0, headerEnd);
        const body = lines.filter((_, index) => index >= headerEnd && !hoistedLines.has(index));

        const uniquePaths = Array.from(new Set([...paths, ...extraPaths]));
        const formatted = this.formatter.groupAndFormatImports(uniquePaths, options.preferDotSyntax, options.sortAlphabetically, options.importGrouping);

        // Put each comment back above the statement it was written for,
        // wherever the sort has since placed that statement. Keying on the
        // formatted statement rather than on a position is what survives
        // grouping, which emits blank separators no path formats to.
        const commentsByStatement = new Map<string, string[]>();
        for (const [path, comments] of commentsByPath) {
            commentsByStatement.set(this.formatter.formatImportStatement(path, options.preferDotSyntax), comments);
        }
        // Both lookups key on the bare statement, so the trailing comment goes
        // on only once both have been read.
        const trailingByStatement = this.trailingCommentsByStatement(blockImports, options.preferDotSyntax);
        const block = formatted.flatMap((statement) => {
            const comments = commentsByStatement.get(statement);
            const line = this.withTrailingComment(statement, trailingByStatement);
            return comments ? [...comments, line] : [line];
        });

        // Drop blank lines the removed imports left at the top; the gap after
        // the block is normalized by ensureEmptyLinesAfterImports afterwards.
        let firstContent = 0;
        while (firstContent < body.length && body[firstContent].trim() === "") {
            firstContent++;
        }
        const remainingBody = body.slice(firstContent);

        if (remainingBody.length === 0) {
            return [...header, ...block].join(eol) + eol;
        }

        // Every path was withheld, so there is no block to separate from the
        // body. Writing the separator anyway would put a blank line where the
        // block would have been.
        if (block.length === 0) {
            return [...header, ...remainingBody].join(eol);
        }

        return [...header, ...block, "", ...remainingBody].join(eol);
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
        // using, and not module-scoped imports inside module bodies). An import
        // that opens a comment over the lines below it - a `<#` block opener or
        // a `<#>` marker - is skipped as well: those lines are that comment's
        // body, so adjusting spacing there would insert or remove lines inside
        // the user's comment rather than after the import block.
        const scannedImports = rewritableImports(scanModuleImports(lines));
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

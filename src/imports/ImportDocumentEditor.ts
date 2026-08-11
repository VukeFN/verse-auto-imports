import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportFormatter } from "./ImportFormatter";
import { allUsingPaths, classifyLines, LINE_SPLIT, LineClassification, pinnedImports, rewritableImports, scanModuleImports, ScannedImport } from "./ImportScanner";

/**
 * A run of import statements on consecutive lines. Any gap starts a new block,
 * because a rebuild rewrites a block's whole line range and would swallow
 * whatever sat in the gap.
 */
interface ImportBlock {
    start: number;
    end: number;
    imports: ScannedImport[];
}

/** The line ending a document is written with. */
export type LineEnding = "\r\n" | "\n";

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
 * it. Rebuilding the block at line 0 puts the header into the middle of the
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
 * other relocates a licence into the middle of the import block.
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
 * The last line a pinned import owns: its own statement, plus the body of any
 * comment it opens below it.
 *
 * Placement needs the whole span rather than the statement, because the line
 * directly below a comment marker is comment text. A `<#>` marker's body is the
 * lines indented past it, and a `<#` leaves every line comment until a matching
 * `#>`, so writing a new import at column 0 on the line after the statement
 * lands it inside the author's comment - which for `<#>` also truncates that
 * comment at the new line, silently discarding the rest of what they wrote.
 *
 * `continuesCommentAbove` is exactly this question already answered: it marks a
 * line whose comment was opened above it, under either marker. So the span ends
 * at the last line still carrying it, and an import pinned only by the
 * statements sharing its line owns its span alone.
 */
function pinnedSpanEnd(imp: ScannedImport, classifications: LineClassification[]): number {
    let end = imp.endLine;
    while (end + 1 < classifications.length && classifications[end + 1].continuesCommentAbove) {
        end++;
    }
    return end;
}

/**
 * The lines a pinned import forbids a newly added `path` from crossing.
 *
 * A pinned import is in no ImportBlock - blocks are built from the movable
 * imports alone, since a writer may not rebuild a pinned line - so every
 * placement decision that reads `importBlocks` is blind to it. It is still a
 * real import that a `using` below it resolves against, so it constrains where
 * a new one may go exactly as the imports inside a block do. Both pin reasons
 * bound placement the same way, for the same reason: the line stays put, so
 * whichever of the two put it there changes nothing about what may cross it.
 *
 * The floor asks what selectTargetBlockIndex asks, so pinned and blocked
 * imports cannot disagree about what precedes what. The ceiling is the one
 * documented override of it, and no pinned import raises both:
 *
 * - `floor` - the last line owned by the lowest pinned import, where the new
 *   path resolves against what is in scope above it
 *   (ImportFormatter.resolvesAgainstScopeAbove). Any of them can be bringing
 *   its first segment into scope, so it goes below all of them. An absolute
 *   path needs nothing above it and is unconstrained.
 * - `ceiling` - the first line of the highest pinned import that could be
 *   resolving against the new one (couldResolveAgainst). The new import goes
 *   directly above it, and that import raises no floor: see pinnedBounds.
 *
 * See couldResolveAgainst for why the override exists, and placementLine for
 * which bound wins where two pinned imports disagree.
 *
 * `-1` means unconstrained in that direction.
 */
interface PinnedBounds {
    floor: number;
    ceiling: number;
}

/**
 * Managing a document's import block: adding the imports a diagnostic asked
 * for, reorganizing what is there, and the blank lines after it.
 *
 * The three share one set of placement rules, which is why they share a class:
 * where an import may go depends on the ranks of the imports already there and
 * on which of them are pinned to their line.
 *
 * Converting an existing import between path forms is ImportPathConverter's,
 * and is the one write into an import line that does not come from here.
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
            // list. A statement sharing its span is refused for the same
            // reason: what trails it is the rest of the span, not an annotation
            // to re-emit.
            if (!imp.trailingComment || imp.anchorsCommentBelow || imp.rebuildLosesText) {
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

    private createBlockReplacementEdit(
        edit: vscode.WorkspaceEdit,
        document: vscode.TextDocument,
        block: ImportBlock,
        newPaths: string[],
        preferDotSyntax: boolean,
        sortAlphabetically: boolean,
        eol: LineEnding,
    ): void {
        const existingBlockPaths = block.imports.map((imp) => imp.path);

        let combinedPaths = [...existingBlockPaths, ...newPaths];
        if (sortAlphabetically) {
            combinedPaths = this.formatter.sortImportsByRank(combinedPaths);
        }

        const formattedImports = this.withTrailingComments(
            combinedPaths.map((path) => this.formatter.formatImportStatement(path, preferDotSyntax)),
            this.trailingCommentsByStatement(block.imports, preferDotSyntax),
        );

        edit.replace(document.uri, new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0)), formattedImports.join(eol) + eol);
    }

    /**
     * Chooses which existing import block a new path must be merged into so the
     * ordering holds across the whole file rather than only inside one block.
     *
     * createBlockReplacementEdit sorts the block it rewrites, so it keeps a new
     * import below a provider only while both sit in that same block. Any blank
     * line between imports starts a second block, so always merging into
     * `importBlocks[0]` could place a new `using { Economy.Shop }` above the
     * `using { Features }` that brings `Economy` into scope - the breakage the
     * sort exists to prevent.
     *
     * The form of the new path decides it, the same question
     * sortImportsByRank asks (ImportFormatter.resolvesAgainstScopeAbove):
     * - a relative path goes in the last block, since every import already in
     *   the file may be the one bringing its first segment into scope and the
     *   sort will keep it below them there.
     * - an absolute path goes in the first, since it needs nothing in scope and
     *   no import has to precede it.
     *
     * @param importBlocks The blocks the new path may go in, in document order.
     *   Never empty - the caller drops a path with no eligible block before
     *   asking. A block is never empty either, so holding an import is not a
     *   condition to check.
     */
    private selectTargetBlockIndex(importBlocks: ImportBlock[], path: string): number {
        return this.formatter.resolvesAgainstScopeAbove(path) ? importBlocks.length - 1 : 0;
    }

    /**
     * Whether an existing import of rank `existing` could be resolving against
     * a newly added import of rank `rank`, which is what forces the new one
     * above it rather than merely preferring it there.
     *
     * This is the one place a newly added import is read as the provider rather
     * than the consumer, and it deliberately overrides the written order every
     * other rule here keeps: the import is being added because a diagnostic
     * asked for it, and a pinned dotted import whose first segment is missing
     * is a diagnostic the extension cannot tell from any other. Placing the new
     * import below it would decline to fix the one file this case exists for.
     *
     * Kept to a pinned dotted consumer and a new import that can supply a first
     * segment for it, because the override is only worth the risk that narrowly.
     * The consequence of an upper bound here is refusing every block and writing
     * a standalone line, so widening it fragments a file into import regions to
     * satisfy nothing.
     */
    private couldResolveAgainst(existing: number, rank: number): boolean {
        return existing === 2 && rank < 2;
    }

    /**
     * Whether hoisting `imp` into a block at the top of the file would carry it
     * above a pinned import that has to precede it.
     *
     * Position is the whole question, not the presence of such an import. The
     * block is written above every pinned line, so an import already above
     * every pinned one lands in the same relation to them afterwards and can be
     * sorted freely; one written below a pinned line would cross it, and a
     * `using` that crosses the import bringing its first segment into scope
     * stops resolving. Holding back an import that was never at risk would
     * leave a file the sort could have repaired unrepaired.
     *
     * Every pinned import above counts, whatever its form: any of them can be
     * the one bringing that first segment into scope
     * (ImportFormatter.resolvesAgainstScopeAbove).
     *
     * A pinned import never constrains its own path: nothing needs itself in
     * scope, and the duplicate of a pinned path the withhold rules deliberately
     * keep would be stranded in the body rather than organized.
     */
    private crossesPinnedProvider(pinned: ScannedImport[], imp: ScannedImport): boolean {
        if (!this.formatter.resolvesAgainstScopeAbove(imp.path)) {
            return false;
        }
        return pinned.some((other) => other.path !== imp.path && other.startLine < imp.startLine);
    }

    /**
     * The last line a pinned import forbids `path` from being hoisted above, or
     * -1 where none does. `path` has no line of its own to keep, so a pinned
     * import that must precede it both rules the block out and names the line
     * the path is written below instead.
     *
     * The floor is pinnedBounds', so a rebuilt block and a singly added import
     * read one rule rather than two. Only the floor: the ceiling pinnedBounds
     * returns with it answers a question this caller has already answered,
     * since a block above every pinned line, and a path written directly below
     * this floor, both precede every pinned import further down.
     *
     * A ceiling raised *above* the floor is the one it genuinely drops: the
     * path lands below a pinned import that could have been the consumer it was
     * added for, leaving that diagnostic unfixed. Deliberate - the alternative
     * carries it above the pinned import bringing its own first segment into
     * scope, and a compiling file outranks a fixed diagnostic.
     *
     * Exempts the path from itself for the reason crossesPinnedProvider does.
     */
    private hoistFloor(pinned: ScannedImport[], classifications: LineClassification[], path: string): number {
        return this.pinnedBounds(
            pinned.filter((imp) => imp.path !== path),
            classifications,
            path,
        ).floor;
    }

    /**
     * Where the imports pinned to their line allow a new `path` to be written.
     * See PinnedBounds.
     */
    private pinnedBounds(pinned: ScannedImport[], classifications: LineClassification[], path: string): PinnedBounds {
        const rank = this.formatter.importRank(path);
        const needsScopeAbove = this.formatter.resolvesAgainstScopeAbove(path);

        let floor = -1;
        let ceiling = -1;
        for (const imp of pinned) {
            // One pinned import raises one bound. Reading it as the consumer
            // and as a possible provider at once would put the floor at or
            // below the ceiling it raised, and blockIsWithin would then refuse
            // every block - including one lying entirely above the ceiling,
            // which satisfies the ceiling and the written order both.
            if (this.couldResolveAgainst(this.formatter.importRank(imp.path), rank)) {
                ceiling = ceiling === -1 ? imp.startLine : Math.min(ceiling, imp.startLine);
                continue;
            }
            if (needsScopeAbove) {
                floor = Math.max(floor, pinnedSpanEnd(imp, classifications));
            }
        }

        return { floor, ceiling };
    }

    /**
     * The line a run of new import statements is written on: `desired`, moved
     * below the floor, and directly above the ceiling wherever there is one.
     *
     * A ceiling is always honoured, and taken exactly rather than as a cap.
     * Both halves matter:
     *
     * - The ceiling wins over the floor. Only couldResolveAgainst raises one,
     *   and it is that predicate's deliberate override: the new import is read
     *   as the provider a pinned dotted import is missing, so it goes above it.
     *   The floor is the opposite reading of the same file - a pinned import
     *   further down could be what the new import resolves through - and the
     *   two cannot both be honoured. Honouring the floor leaves the diagnostic
     *   that asked for the import unfixed, which is the case the override
     *   exists for.
     * - Taken exactly, because the ceiling is the *lowest* legal line: the new
     *   import must precede that statement, so everything below the ceiling is
     *   ruled out and everything above it is merely further away. Landing
     *   directly above the statement that needs it keeps it beside its
     *   consumer, and keeps it off line 0, where a `desired` of 0 would put it
     *   above the file header - which headerLineCount calls the one place a
     *   header must never be.
     */
    private placementLine(desired: number, bounds: PinnedBounds): number {
        if (bounds.ceiling !== -1) {
            return bounds.ceiling;
        }
        return Math.max(desired, bounds.floor + 1);
    }

    /** Whether a block sits entirely inside the space the pinned imports leave for `path`. */
    private blockIsWithin(block: ImportBlock, bounds: PinnedBounds): boolean {
        return block.start > bounds.floor && (bounds.ceiling === -1 || block.end < bounds.ceiling);
    }

    /**
     * Whether a block sits far enough down the file for `path` to join it
     * without crossing a relative import written below it.
     *
     * The grouped writer picks its block by group identity, which is a question
     * about a block's content and not about its position, so the block it picks
     * can have another below it: a mixed block counts as neither group and is
     * skipped over rather than ruled out. A relative path resolves its first
     * segment against what the `using` statements above it brought into scope
     * (ImportFormatter.resolvesAgainstScopeAbove), so a relative import further
     * down may be the one it needs, and joining a block above that import stops
     * the file compiling. Grouping yields, since a grouped file that no longer
     * compiles is the worse of the two.
     *
     * Only the relative imports below count, and an absolute one below is
     * knowingly let through. A grouped file writes one group above the other by
     * definition, so under localFirst every digest import sits below the local
     * group: reading an absolute import as a possible provider would refuse
     * that group to every relative path and leave the strategy with nothing to
     * do. The residual is real, and is not the same judgement pinnedBounds
     * makes - a relative path can still land above an absolute import in a
     * later block that could be bringing its first segment into scope, where a
     * pinned absolute import of the same shape would have pushed it below.
     * A pinned line cannot be moved or grouped, so nothing chose that order;
     * the grouping strategy is the user choosing this one.
     */
    private blockKeepsRelativeOrder(importBlocks: ImportBlock[], blockIndex: number, path: string): boolean {
        if (!this.formatter.resolvesAgainstScopeAbove(path)) {
            return true;
        }
        return !importBlocks.some((block, index) => index > blockIndex && block.imports.some((imp) => this.formatter.resolvesAgainstScopeAbove(imp.path)));
    }

    /**
     * Writes a run of import statements on their own lines at `line`.
     *
     * One home for the end-of-document case, which every caller has to handle
     * the same way: the line after the last one does not exist in a document
     * with no trailing newline, and VS Code clamps a position past the end onto
     * the end of the last line - splicing the first statement onto whatever is
     * already there and leaving one unreadable line where two belong.
     */
    private insertImportLines(edit: vscode.WorkspaceEdit, document: vscode.TextDocument, line: number, statements: string[], eol: LineEnding, blankLineAfter: boolean): void {
        const text = statements.join(eol);

        if (line < document.lineCount) {
            edit.insert(document.uri, new vscode.Position(line, 0), text + eol + (blankLineAfter ? eol : ""));
            return;
        }

        edit.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, eol + text);
    }

    /**
     * Groups paths no block can take by the line each has to be written on,
     * starting from the line the site would have used had no import been
     * pinned. Paths wanting the same line are written together.
     */
    private groupByPlacementLine(paths: string[], desired: number, pinned: ScannedImport[], classifications: LineClassification[]): Map<number, string[]> {
        const byLine = new Map<number, string[]>();
        for (const path of paths) {
            const line = this.placementLine(desired, this.pinnedBounds(pinned, classifications, path));
            byLine.set(line, [...(byLine.get(line) ?? []), path]);
        }
        return new Map([...byLine].sort(([a], [b]) => a - b));
    }

    /**
     * The paths among `movable` that a pinned import holds on the line they
     * were written on, rather than let a rebuilt block at the top carry them
     * above it. Untidy, against a file that no longer compiles.
     *
     * Keyed on the path, not the import, because the block is built from sets
     * of paths and can only decide per path. Whichever reader keys per import
     * while the other keys per path deletes a line whose path the block then
     * declines to re-emit. The cost is declining to hoist a copy written above
     * every pinned import when another copy below one is grounded.
     *
     * Shared by the two writers that hoist into such a block, which is what
     * keeps them from holding two rules about what a pinned line stops.
     */
    private groundedPaths(pinned: ScannedImport[], movable: ScannedImport[]): Set<string> {
        return new Set(movable.filter((imp) => this.crossesPinnedProvider(pinned, imp)).map((imp) => imp.path));
    }

    /**
     * The line ranges of a block that consolidating at the top may delete: the
     * runs of imports it hoists, with the grounded ones left out.
     *
     * Deleting the block whole would take a grounded import's line with it while
     * its path is deliberately not re-emitted at the top, losing the import
     * rather than moving it. A block's imports are adjacent by construction, so
     * a block with nothing grounded yields one run covering exactly the block.
     */
    private hoistedRuns(block: ImportBlock, grounded: Set<string>): Array<{ start: number; end: number }> {
        const runs: Array<{ start: number; end: number }> = [];
        for (const imp of block.imports) {
            if (grounded.has(imp.path)) {
                continue;
            }

            const last = runs[runs.length - 1];
            if (last && imp.startLine === last.end + 1) {
                last.end = imp.endLine;
            } else {
                runs.push({ start: imp.startLine, end: imp.endLine });
            }
        }
        return runs;
    }

    /**
     * The module import statements a document holds, deduplicated, with an
     * indented pair (`using:` plus its path line) joined into one statement.
     * Local-scope `using` is not among them.
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
     * Writes the statements whose paths the document does not already import,
     * then normalizes the blank lines after the block. True when nothing needed
     * adding, as well as when the edit succeeded.
     *
     * Where they go is `behavior.preserveImportLocations`: with it on, each
     * path is merged into an existing block or written on its own line beside
     * the imports it must sit relative to; with it off, the movable imports are
     * consolidated at the top, bar any a pinned line holds where it is.
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

        // Blocks are built from the movable imports below, so a pinned one is
        // in none of them and no placement decision can see it. Kept here, with
        // the comment structure a placement needs to read its span, so every
        // site can bound itself against them. See PinnedBounds.
        //
        // Both pin reasons, because the two are indistinguishable to placement:
        // either way the line stays where it was written, and a new import may
        // not cross it.
        const classifications = classifyLines(lines);
        const pinned = pinnedImports(scannedImports);

        const importBlocks: ImportBlock[] = [];
        for (const imp of rewritableImports(scannedImports)) {
            logger.debug("ImportDocumentEditor", `Found existing import at line ${imp.startLine}: ${imp.path}`);

            const lastBlock = importBlocks[importBlocks.length - 1];
            if (lastBlock && imp.startLine === lastBlock.end + 1) {
                lastBlock.end = imp.endLine;
                lastBlock.imports.push(imp);
            } else {
                importBlocks.push({ start: imp.startLine, end: imp.endLine, imports: [imp] });
            }
        }

        logger.debug("ImportDocumentEditor", `Found ${scannedImports.length} existing imports in ${importBlocks.length} blocks`);

        // Existence is judged from every import, a pinned one included: it is
        // imported, so nothing needs adding for it.
        const existingPaths = new Set<string>(scannedImports.map((imp) => imp.path));
        // Relocation is judged only from the movable ones. Re-emitting a
        // pinned path at the top while its own line necessarily stays put
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
            // A gap between two blocks is the author's own grouping, so the
            // configured strategy is applied by adding to whichever group each
            // new path belongs in rather than by regrouping the file.
            const hasGrouping =
                importGrouping !== "none" &&
                importBlocks.length >= 2 &&
                importBlocks.some((block, i) => {
                    if (i === 0) return false;
                    return block.start > importBlocks[i - 1].end + 1;
                });

            if (hasGrouping && importBlocks.length >= 2) {
                let digestBlockIndex = -1;
                let localBlockIndex = -1;

                importBlocks.forEach((block, index) => {
                    const blockPaths = block.imports.map((imp) => imp.path);
                    const hasDigest = blockPaths.some((path) => this.formatter.isDigestImport(path));
                    const hasLocal = blockPaths.some((path) => !this.formatter.isDigestImport(path));

                    // A block counts as a group only if it is pure. A mixed one
                    // is evidence of nothing, so it is left as neither and
                    // takes no new import.
                    if (hasDigest && !hasLocal) {
                        digestBlockIndex = index;
                    } else if (hasLocal && !hasDigest) {
                        localBlockIndex = index;
                    }
                });

                const newDigestPaths: string[] = [];
                const newLocalPaths: string[] = [];

                for (const path of newImportPaths) {
                    if (this.formatter.isDigestImport(path)) {
                        newDigestPaths.push(path);
                    } else {
                        newLocalPaths.push(path);
                    }
                }

                // A block can only take a new import where both the pinned
                // imports and the movable ones below it leave room for it.
                // Rebuilding a block writes the new statement at that block's
                // lines, so which block absorbs a path is a placement decision
                // like any other, and a block sitting above a provider cannot
                // make one. The two bounds count different imports, though:
                // see blockKeepsRelativeOrder for why an absolute import in a
                // later block is let through where a pinned one is not.
                //
                // Partitioned in one pass rather than filtered twice, so taken
                // and unhandled are complements by construction: two filters
                // that have to stay each other's negation write a path into
                // both lists, or into neither, as soon as one is edited alone.
                const splitForBlock = (blockIndex: number, paths: string[]): { taken: string[]; unhandled: string[] } => {
                    const taken: string[] = [];
                    const unhandled: string[] = [];
                    for (const path of paths) {
                        const canTake =
                            blockIndex >= 0 &&
                            this.blockIsWithin(importBlocks[blockIndex], this.pinnedBounds(pinned, classifications, path)) &&
                            this.blockKeepsRelativeOrder(importBlocks, blockIndex, path);
                        (canTake ? taken : unhandled).push(path);
                    }
                    return { taken, unhandled };
                };

                const digest = splitForBlock(digestBlockIndex, newDigestPaths);
                const local = splitForBlock(localBlockIndex, newLocalPaths);

                if (digest.taken.length > 0) {
                    this.createBlockReplacementEdit(edit, document, importBlocks[digestBlockIndex], digest.taken, preferDotSyntax, sortAlphabetically, eol);
                }

                if (local.taken.length > 0) {
                    this.createBlockReplacementEdit(edit, document, importBlocks[localBlockIndex], local.taken, preferDotSyntax, sortAlphabetically, eol);
                }

                // Imports no block took: one with no matching block, and one
                // its matching block cannot hold - because a pinned import
                // keeps it out, or because a relative import below it does.
                const unhandledPaths = [...digest.unhandled, ...local.unhandled];

                if (unhandledPaths.length > 0) {
                    const desired = importBlocks.length > 0 ? importBlocks[importBlocks.length - 1].end + 1 : 0;
                    for (const [line, paths] of this.groupByPlacementLine(unhandledPaths, desired, pinned, classifications)) {
                        this.insertImportLines(edit, document, line, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), eol, importBlocks.length === 0);
                    }
                }
            } else {
                if (importGrouping !== "none" && existingPaths.size > 0) {
                    // Grouping is wanted and the file has none, so the imports
                    // are regrouped in place. A new path a pinned import
                    // keeps out of the rebuilt block is written on its own line
                    // below that import instead, rather than into a group that
                    // sits above it. Only the new paths are asked: this branch
                    // sees at most one block (2+ gapped blocks reach the
                    // hasGrouping branch above), so every relocated path is
                    // already inside the block being rebuilt in place.
                    const displacedPaths =
                        importBlocks.length > 0 ? Array.from(newImportPaths).filter((path) => !this.blockIsWithin(importBlocks[0], this.pinnedBounds(pinned, classifications, path))) : [];
                    const displaced = new Set(displacedPaths);

                    const allPaths = new Set<string>([...relocatablePaths, ...newImportPaths].filter((path) => !displaced.has(path)));
                    const allImportsArray = Array.from(allPaths);
                    const groupedImports = this.withTrailingComments(
                        this.formatter.groupAndFormatImports(allImportsArray, preferDotSyntax, sortAlphabetically, importGrouping),
                        this.trailingCommentsByStatement(rewritableImports(scannedImports), preferDotSyntax),
                    );

                    if (importBlocks.length > 0) {
                        // In place, so the block stays where the author put it
                        // rather than moving to the top of the file. The loop
                        // over any further block is defensive: this branch sees
                        // only one, as above.
                        const firstBlock = importBlocks[0];
                        edit.replace(document.uri, new vscode.Range(new vscode.Position(firstBlock.start, 0), new vscode.Position(firstBlock.end + 1, 0)), groupedImports.join(eol) + eol);

                        for (let i = importBlocks.length - 1; i >= 1; i--) {
                            const block = importBlocks[i];
                            edit.delete(document.uri, new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0)));
                        }

                        for (const [line, paths] of this.groupByPlacementLine(displacedPaths, firstBlock.end + 1, pinned, classifications)) {
                            this.insertImportLines(edit, document, line, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), eol, false);
                        }
                    } else {
                        // No existing block - write the imports at the top, or
                        // below a pinned import that has to precede one of
                        // them. Split by line like every other site rather than
                        // written as one run under a merged bound: paths of
                        // different ranks take their bounds from different
                        // pinned imports, and one path's floor can sit below
                        // another's ceiling, leaving the group no line it can
                        // legally occupy at all.
                        //
                        // A relocated path is never among these. Every
                        // rewritable import opens or extends a block, so no
                        // block means none of them, which is also why the
                        // trailing comments here are always empty.
                        for (const [line, paths] of this.groupByPlacementLine(allImportsArray, 0, pinned, classifications)) {
                            this.insertImportLines(edit, document, line, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), eol, true);
                        }
                    }
                } else {
                    const newImportPathsArray = Array.from(newImportPaths);

                    if (sortAlphabetically && importBlocks.length > 0) {
                        // Merge each new import into an existing block in place
                        // so the combined block is sorted as one, with the
                        // absolute paths at the top and every relative import
                        // in its written order. Appending the new imports after
                        // the block instead would leave them below imports the
                        // sort had already placed, in a second region the sort
                        // never sees together.
                        //
                        // Which block each import joins is a whole-file
                        // decision, not always the first one: sorting one block
                        // orders the new import against that block alone, which
                        // leaves it free to sit above a provider in another
                        // block (see selectTargetBlockIndex).
                        //
                        // Only a block inside the space the pinned imports
                        // leave is eligible, and the selector chooses among
                        // those. A pinned import is in no block, so offering
                        // the selector every block lets it merge an import into
                        // one above the pinned provider that import needs.
                        const pathsByBlock = new Map<number, string[]>();
                        const unblockedPaths: string[] = [];
                        for (const path of newImportPathsArray) {
                            const bounds = this.pinnedBounds(pinned, classifications, path);
                            const eligible = importBlocks.map((block, index) => ({ block, index })).filter(({ block }) => this.blockIsWithin(block, bounds));

                            if (eligible.length === 0) {
                                // No block sits where this import may go, so it
                                // is written on its own line there instead.
                                unblockedPaths.push(path);
                                continue;
                            }

                            // The selector reports a position in the list it was
                            // given, so its answer is read back through that
                            // list to reach the real block.
                            const chosen = this.selectTargetBlockIndex(
                                eligible.map(({ block }) => block),
                                path,
                            );
                            const index = eligible[chosen].index;
                            const targetPaths = pathsByBlock.get(index);
                            if (targetPaths) {
                                targetPaths.push(path);
                            } else {
                                pathsByBlock.set(index, [path]);
                            }
                        }

                        // Blocks are disjoint, so the replacements never overlap.
                        // Neither can a standalone line below collide with one.
                        // placementLine returns one of two things, and a pinned
                        // import's span holds no block line either way: its own
                        // line breaks the contiguity a block is built from, and
                        // wherever the span runs past that line the rest of it
                        // is comment body, so no column-0 import the scanner
                        // would collect can be in it.
                        //
                        // - A ceiling, which is a pinned import's own line.
                        // - floor + 1, reached only when every block was
                        //   refused, which for a path with no ceiling means
                        //   every block starts at or below the floor. The floor
                        //   is the end of a pinned span, so a block starting
                        //   at or below it ends before that span begins, and
                        //   floor + 1 is past the end of the block.
                        for (const index of [...pathsByBlock.keys()].sort((a, b) => a - b)) {
                            this.createBlockReplacementEdit(edit, document, importBlocks[index], pathsByBlock.get(index)!, preferDotSyntax, true, eol);
                        }

                        for (const [line, paths] of this.groupByPlacementLine(unblockedPaths, 0, pinned, classifications)) {
                            this.insertImportLines(edit, document, line, this.formatter.groupAndFormatImports(paths, preferDotSyntax, true, importGrouping), eol, true);
                        }
                    } else {
                        // Sorting off, or no block to merge into: the new
                        // imports are appended and no existing line is touched.
                        //
                        // After the last import block, not the first: with
                        // sorting off nothing reorders a block afterwards, so
                        // any earlier position could leave a new import above
                        // one that has to stay above it.
                        //
                        // Wherever that block sits, not only when it starts at
                        // line 0. A file whose imports open below a licence
                        // header has its first block at a later line, so
                        // inserting at line 0 there writes the new import above
                        // the header and leaves two disconnected import regions
                        // behind.
                        //
                        // With no block at all the top of the file is where a
                        // new import goes - unless a pinned import that has to
                        // precede it sits there, which is the one case a file
                        // whose only import is pinned always reaches. That is
                        // what groupByPlacementLine answers, from either start.
                        const desired = importBlocks.length > 0 ? importBlocks[importBlocks.length - 1].end + 1 : 0;
                        const blankLineAfter = importBlocks.length === 0;

                        for (const [line, paths] of this.groupByPlacementLine(newImportPathsArray, desired, pinned, classifications)) {
                            this.insertImportLines(edit, document, line, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), eol, blankLineAfter);
                        }
                    }
                }
            }
        } else {
            // The block is written above every pinned line, so hoisting an
            // import from below one carries it across. See groundedPaths.
            const grounded = this.groundedPaths(pinned, rewritableImports(scannedImports));

            // A new path has no line of its own to keep, so a pinned import
            // that has to precede it names the line it is written below
            // instead. The floor alone, as buildOrganizedContent asks of a path
            // it adds and for its reason: this block goes above every pinned
            // line, so a ceiling is already satisfied by it. See hoistFloor.
            const blockPaths = new Set<string>(Array.from(relocatablePaths).filter((path) => !grounded.has(path)));
            const newPathsByLine = new Map<number, string[]>();
            for (const path of newImportPaths) {
                const floor = this.hoistFloor(pinned, classifications, path);
                if (floor === -1) {
                    blockPaths.add(path);
                    continue;
                }
                newPathsByLine.set(floor + 1, [...(newPathsByLine.get(floor + 1) ?? []), path]);
            }

            // Grounding can leave the block with nothing to write, and an empty
            // block is a stray line ending at the top of the file.
            if (blockPaths.size > 0) {
                const formattedImports = this.withTrailingComments(
                    this.formatter.groupAndFormatImports(Array.from(blockPaths), preferDotSyntax, sortAlphabetically, importGrouping),
                    this.trailingCommentsByStatement(rewritableImports(scannedImports), preferDotSyntax),
                );

                // No blank line after the block: ensureEmptyLinesAfterImports
                // runs once the edit has been applied and puts the configured
                // number there.
                const importsText = formattedImports.join(eol) + eol;
                edit.insert(document.uri, new vscode.Position(0, 0), importsText);
            }

            for (const [line, paths] of [...newPathsByLine].sort(([a], [b]) => a - b)) {
                this.insertImportLines(edit, document, line, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), eol, false);
            }

            for (let i = importBlocks.length - 1; i >= 0; i--) {
                for (const run of this.hoistedRuns(importBlocks[i], grounded).reverse()) {
                    edit.delete(document.uri, new vscode.Range(new vscode.Position(run.start, 0), new vscode.Position(run.end + 1, 0)));
                }
            }
        }

        try {
            const success = await vscode.workspace.applyEdit(edit);
            logger.info("ImportDocumentEditor", success ? "Successfully updated imports in document" : "Failed to update imports in document");

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
     * A pinned import also bounds the block the file is organized around:
     * nothing is carried across a pinned import that has to precede it. One
     * written above such a line is hoisted like any other, the block being
     * above that line as well; one written below it keeps its line, untidy but
     * compiling. An additional path has no line to keep, so it is written
     * directly below the pinned statement that constrains it. See
     * crossesPinnedProvider and hoistFloor.
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
        const classifications = classifyLines(lines);
        const headerEnd = headerLineCount(classifications);
        // A pinned import - one anchored by a comment marker, or one sharing its
        // span with another statement - is neither hoisted nor removed from the
        // body: its line stays exactly where it is, and the rest of the file is
        // organized around it. It is still an import, though, so an additional
        // path it already covers must not be written out a second time - that
        // would duplicate it rather than move it. Both reasons answer that the
        // same way, so the set is keyed on the line staying put rather than on
        // why it does; see ScannedImport.rebuildLosesText.
        const allImports = scanModuleImports(lines);
        const movableImports = rewritableImports(allImports);
        const pinned = pinnedImports(allImports);
        const pinnedPaths = new Set(pinned.map((imp) => imp.path));

        // The block goes above every pinned line, so an import that hoisting
        // would carry above a pinned one it needs is left on the line it was
        // written on. A `using` resolves its own path top-down, so a path whose
        // first segment the pinned import brings into scope has to stay below
        // it. See groundedPaths.
        const grounded = this.groundedPaths(pinned, movableImports);
        const hoistableImports = movableImports.filter((imp) => !grounded.has(imp.path));

        // A path the file already imports is not written again, whichever
        // statement holds it - pinned, grounded, or hoisted into the block. The
        // block's own deduplication answers for none of them once a path can be
        // written below a pinned line instead of into the block: what lands
        // there is compared against nothing.
        const importedPaths = new Set(allImports.map((imp) => imp.path));
        const extraPaths = Array.from(new Set(additionalPaths.map((p) => p.trim()))).filter((p) => p.length > 0 && !importedPaths.has(p));

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
        // first segment already in scope above it, which is why the sort leaves
        // those in written order (see ImportFormatter.sortImportsByRank). The
        // anchored line ends up below the rebuilt block, so withholding the copy
        // above it can strand such a path - in the block, or further down the
        // body where scanModuleImports does not even look, as in a
        // module-definition body.
        //
        // So this asks the whole file, every `using` at every indentation, and
        // withholds only where all of them are absolute. An absolute path needs
        // nothing in scope, so nothing anywhere can be resolving against the
        // copy being removed. A `using` that is not absolute blocks it whichever
        // meaning it carries - judging that needs the enclosing construct, and
        // guessing wrong is what deletes a provider. So the question asked is
        // just the path's form.
        //
        // extraPaths joins the question because those paths are written into the
        // block too. They keep their own unconditional filter above: suppressing
        // one only declines to add an import the file already has, which cannot
        // strand anything, while withholding a line the file already holds can.
        //
        // The cost is declining to tidy any file that holds a bare or dotted
        // `using` anywhere, a local-scope one included. That is the safe
        // direction: the duplicate left behind is legal Verse, and a stranded
        // provider is a file that stops compiling.
        const withholdIsSafe = [...allUsingPaths(lines), ...extraPaths].every((path) => !this.formatter.resolvesAgainstScopeAbove(path));
        const blockImports = withholdIsSafe ? hoistableImports.filter((imp) => !pinnedPaths.has(imp.path)) : hoistableImports;

        const paths = blockImports.map((imp) => imp.path);
        // Keyed on the unfiltered set: a file whose only rewritable import is
        // such a duplicate still has work to do, and returning null here would
        // leave the document - and the duplicate - untouched.
        if (movableImports.length === 0 && extraPaths.length === 0) {
            return null;
        }

        // An additional path the block cannot take is written on its own line
        // directly below the pinned statement that constrains it, since it has
        // no line of its own to keep. Declining to write it at all would make
        // organizing a file with such an import silently add nothing.
        //
        // Grouped by line as groupByPlacementLine groups the add path's, and
        // deliberately not through it: that one places a run against a document
        // being edited, honouring a ceiling as well, while these are spliced
        // into text being rebuilt and hoistFloor says why no ceiling binds.
        const topExtraPaths: string[] = [];
        const groundedExtrasByLine = new Map<number, string[]>();
        for (const path of extraPaths) {
            const floor = this.hoistFloor(pinned, classifications, path);
            if (floor === -1) {
                topExtraPaths.push(path);
                continue;
            }
            groundedExtrasByLine.set(floor, [...(groundedExtrasByLine.get(floor) ?? []), path]);
        }

        // Every line the rebuilt block accounts for: the import statements
        // themselves, and the comment lines written above them, which are part
        // of the statement they annotate rather than of the body. A grounded
        // import is in neither list - its statement and its comments stay in
        // the body, where they already read correctly.
        const hoistedLines = new Set<number>();
        const commentsByPath = new Map<string, string[]>();
        for (const imp of hoistableImports) {
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
        const body: string[] = [];
        for (let index = headerEnd; index < lines.length; index++) {
            if (!hoistedLines.has(index)) {
                body.push(lines[index]);
            }
            const groundedExtras = groundedExtrasByLine.get(index);
            if (groundedExtras) {
                // Grouping is a property of the block at the top, so a run
                // written between two body lines is emitted ungrouped: the
                // separator a strategy puts between its two groups would read
                // as a gap in the code around it.
                body.push(...this.formatter.groupAndFormatImports(groundedExtras, options.preferDotSyntax, options.sortAlphabetically, "none"));
            }
        }

        const uniquePaths = Array.from(new Set([...paths, ...topExtraPaths]));
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
     * The edits that would give the file the configured number of empty lines
     * after its import block, or an empty array when it already has them.
     *
     * Kept separate from applying them because the save path participates in
     * the save with these edits (see the onWillSaveTextDocument listener in
     * extension.ts) rather than editing the document afterwards, which would
     * leave the tab dirty the moment it was saved.
     */
    computeEmptyLinesAfterImportsEdits(document: vscode.TextDocument): vscode.TextEdit[] {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const emptyLinesAfterImports = config.get<number>("behavior.emptyLinesAfterImports", 1);

        // A negative value means "leave the file's own spacing alone";
        // package.json declares -1 for it. Without this return the negative
        // difference below deletes real code.
        if (emptyLinesAfterImports < 0) {
            logger.debug("ImportDocumentEditor", `Preserving the existing spacing (emptyLinesAfterImports is ${emptyLinesAfterImports})`);
            return [];
        }

        // A line count has to be a whole number: the difference below is taken
        // against a count of real lines, and `repeat` truncates a fractional
        // count to nothing, so a stored 1.5 would ask for an edit that changes
        // nothing on every save and never converge. package.json declares this
        // an integer, but a hand-edited settings.json still reaches here.
        // Must round after the negative return above, not before: -0.4 rounds
        // to 0, which would take the opt-out's meaning away from it.
        const targetEmptyLines = Math.round(emptyLinesAfterImports);

        logger.debug("ImportDocumentEditor", `Ensuring ${targetEmptyLines} empty lines after imports`);

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

        if (lastImportLine === -1 || lastImportLine === lines.length - 1) {
            logger.debug("ImportDocumentEditor", "No imports found or file ends with imports, skipping spacing adjustment");
            return [];
        }

        let existingEmptyLines = 0;
        for (let i = lastImportLine + 1; i < lines.length; i++) {
            if (lines[i].trim() === "") {
                existingEmptyLines++;
            } else {
                break;
            }
        }

        let hasContentAfterImports = false;
        for (let i = lastImportLine + 1; i < lines.length; i++) {
            if (lines[i].trim() !== "") {
                hasContentAfterImports = true;
                break;
            }
        }

        // The setting is spacing between the block and the code below it, so a
        // file trailing nothing but blank lines has no gap to size and keeps
        // whatever it has.
        if (!hasContentAfterImports) {
            logger.debug("ImportDocumentEditor", "No content after imports, skipping spacing adjustment");
            return [];
        }

        const lineDifference = targetEmptyLines - existingEmptyLines;

        if (lineDifference === 0) {
            logger.debug("ImportDocumentEditor", `Already has ${targetEmptyLines} empty lines after imports`);
            return [];
        }

        if (lineDifference > 0) {
            const newLines = eol.repeat(lineDifference);
            const insertPosition = new vscode.Position(lastImportLine + 1, 0);
            logger.info("ImportDocumentEditor", `Adding ${lineDifference} empty lines after imports`);
            return [vscode.TextEdit.insert(insertPosition, newLines)];
        }

        const linesToRemove = Math.abs(lineDifference);
        const startLine = lastImportLine + 1;
        const endLine = Math.min(startLine + linesToRemove, lines.length);
        const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, 0));
        logger.info("ImportDocumentEditor", `Removing ${linesToRemove} empty lines after imports`);
        return [vscode.TextEdit.delete(range)];
    }

    /**
     * Applies the spacing edits to the document. Used by the paths that already
     * hold the document open and edit it - adding imports and organizing them.
     * The save path uses computeEmptyLinesAfterImportsEdits instead.
     */
    async ensureEmptyLinesAfterImports(document: vscode.TextDocument): Promise<boolean> {
        const edits = this.computeEmptyLinesAfterImportsEdits(document);

        if (edits.length === 0) {
            return true;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, edits);

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

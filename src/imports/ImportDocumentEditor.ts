import * as vscode from "vscode";
import { logger, settingsFor } from "../utils";
import { DiagnosticPosition, DiagnosticPositionsByPath, DiagnosticPositionsByStatement } from "../types";
import { ImportFormatter } from "./ImportFormatter";
import { verifyOrganizedRewrite } from "./ImportRewriteGuard";
import {
    allUsingPaths,
    classifyLines,
    indentedBodyLine,
    indentedPairPathLine,
    LINE_SPLIT,
    LineClassification,
    pinnedImports,
    rewritableImports,
    scanModuleImports,
    ScannedImport,
} from "./ImportScanner";

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

/** A rewrite of lines [start, endExclusive) as `newLines`. Equal bounds insert above `start`. */
export interface LineSplice {
    start: number;
    endExclusive: number;
    newLines: string[];
}

/**
 * `text` with every splice applied, or null where two overlap or one reaches
 * outside its lines. No placement branch emits either shape, so a null is a
 * composition bug - and it has to be answered here rather than by the rewrite
 * guard, which compares paths as a set and so cannot see an import written
 * twice by overlapping splices.
 *
 * A line no splice touches comes back byte for byte, its own line ending
 * included - rejoining the whole document with one ending would rewrite lines
 * the caller never asked about, in a file whose endings are mixed. Only the
 * spliced-in lines take `eol`, each written with an ending after it; a run
 * appended past the last line instead opens with one and closes without, the
 * one way to extend a document that does not end in a line break.
 *
 * Insertions at one line keep their given order, and an insertion at the start
 * of a replaced range goes first, as VS Code applies a WorkspaceEdit's.
 */
export function spliceLines(text: string, splices: LineSplice[], eol: LineEnding): string | null {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
            lineStarts.push(i + 1);
        }
    }
    const lineCount = lineStarts.length;
    const raw = (fromLine: number, toLineExclusive: number): string => {
        if (fromLine >= lineCount) {
            return "";
        }
        return text.slice(lineStarts[fromLine], toLineExclusive < lineCount ? lineStarts[toLineExclusive] : text.length);
    };

    const ordered = [...splices].sort((a, b) => a.start - b.start || a.endExclusive - b.endExclusive);

    let out = "";
    let cursor = 0;
    for (const splice of ordered) {
        if (splice.start < cursor || splice.endExclusive < splice.start || splice.endExclusive > lineCount) {
            return null;
        }
        out += raw(cursor, splice.start);
        if (splice.start >= lineCount) {
            out += eol + splice.newLines.join(eol);
        } else {
            for (const line of splice.newLines) {
                out += line + eol;
            }
        }
        cursor = splice.endExclusive;
    }
    out += raw(cursor, lineCount);
    return out;
}

/**
 * A replacement of characters [start, end) with `newText`. Offsets are UTF-16
 * units into the text the splice was computed from, which is how VS Code
 * positions count as well.
 */
export interface TextSplice {
    start: number;
    end: number;
    newText: string;
}

/**
 * The one line-aligned edit that turns `before` into `after`, or null when the
 * two already match.
 *
 * Character-offset arithmetic rather than a line diff, for two shapes a line
 * diff gets wrong: a hunk reaching the end of a document with no trailing
 * newline, where rejoining lines invents one; and a rebuild that only
 * normalizes line endings, whose lines all compare equal while the text does
 * not. Both bounds sit on a line start or the text's own end, so the range
 * never splits a CRLF pair.
 */
export function minimalSplice(before: string, after: string): TextSplice | null {
    if (before === after) {
        return null;
    }

    const sharedMax = Math.min(before.length, after.length);
    let shared = 0;
    while (shared < sharedMax && before[shared] === after[shared]) {
        shared++;
    }
    const start = shared === 0 ? 0 : before.lastIndexOf("\n", shared - 1) + 1;

    // Bounded away from the snapped prefix in both texts, so the two never
    // claim one character twice.
    const suffixMax = sharedMax - start;
    let suffix = 0;
    while (suffix < suffixMax && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
        suffix++;
    }
    let end = before.length - suffix;
    if (end > start && end < before.length && before[end - 1] !== "\n") {
        const lineBreak = before.indexOf("\n", end);
        end = lineBreak === -1 ? before.length : lineBreak + 1;
    }

    return { start, end, newText: after.slice(start, after.length - (before.length - end)) };
}

/**
 * The position of `offset` in `text`, counting lines by "\n". Computed from
 * the text a splice was measured against, never from the document, which may
 * disagree with it by the time the edit is built.
 */
function positionAt(text: string, offset: number): vscode.Position {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
        if (text[i] === "\n") {
            line++;
            lineStart = i + 1;
        }
    }
    return new vscode.Position(line, offset - lineStart);
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
 * Neither is the run an unterminated `<#` swallowed. A block comment left open
 * runs to the end of the buffer, so a run reaching that end has no line below
 * it to write an import on and naming it would put the import inside the
 * comment - where the scanner cannot see it, and the next compile adds it
 * again. Only the closed lines above the opener are header.
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

    // Step back over the run an unclosed opener holds, to the line that opener
    // sits on. Back to that line and no further: a header closed above it is
    // still a header, and starting from 0 instead would write the import above
    // a licence, which is the placement this function exists to prevent.
    //
    // Reached only where the walk found no code line at all, since a line below
    // one ending inside a block comment cannot be code.
    if (end === classifications.length) {
        while (end > 0 && classifications[end - 1].endsInsideBlockComment) {
            end--;
        }
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
 *
 * An indented `using:` pair reaches past the statement the same way, and has to
 * be asked separately: the pair's own scan entry already reaches its path line,
 * but a line may write a complete `using` and then open a pair, and that
 * statement's entry ends on the opener. Reading the opener alone leaves the
 * path line free, and a new import written there leaves the `using:` with no
 * body.
 *
 * An indented body reaches past it for the third time, and is the general case
 * of the pair: a pinned line sharing itself with any block opener - `M :=
 * module:`, a clause continued below - owns the lines indented under it, and a
 * new import written at column 0 there ends the block before its body. See
 * indentedBodyLine.
 *
 * The rules alternate rather than run in turn, because any can extend a span
 * another then extends again: a pair's path line may itself open a comment over
 * the lines below it, and a body can hold a nested pair.
 *
 * The pair rule goes first, and that order is load-bearing. Each hop re-anchors
 * on the new end, and only the opener line carries the `using:` - so where the
 * opener also opens a comment, letting the comment rule run first steps the
 * anchor past the opener and the pair is never found at all. The body rule goes
 * last for no such reason: it reads the first line of code below the anchor,
 * which the other two hops reach by their own routes and never step past.
 */
function pinnedSpanEnd(imp: ScannedImport, classifications: LineClassification[]): number {
    let end = imp.endLine;
    for (;;) {
        const pathLine = indentedPairPathLine(classifications, end);
        if (pathLine > end) {
            end = pathLine;
            continue;
        }
        if (end + 1 < classifications.length && classifications[end + 1].continuesCommentAbove) {
            end++;
            continue;
        }
        const bodyLine = indentedBodyLine(classifications, end);
        if (bodyLine > end) {
            end = bodyLine;
            continue;
        }
        return end;
    }
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
 * - `ceiling` - the first line of the highest pinned import a diagnostic shows
 *   is resolving against the new one (couldResolveAgainst). The new import goes
 *   directly above it, and that import raises no floor: see pinnedBounds.
 *
 * See couldResolveAgainst for what counts as that evidence, and placementLine
 * for which bound wins where two pinned imports disagree.
 *
 * `-1` means unconstrained in that direction.
 */
interface PinnedBounds {
    floor: number;
    ceiling: number;
}

/**
 * For a caller that cannot name the diagnostic behind a path. It raises no
 * ceiling, which is the ordering every other rule here keeps.
 */
const NO_DIAGNOSTIC_POSITIONS: DiagnosticPositionsByPath = new Map();

/** The options every rebuild takes, whichever placement policy runs it. */
export interface RebuildOptions {
    preferDotSyntax: boolean;
    sortAlphabetically: boolean;
    importGrouping: string;
    /** Line ending to use when the text has no line break to detect one from. */
    fallbackEol?: LineEnding;
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

    /**
     * The write queued last for each document, keyed on its URI, or no entry
     * once nothing is queued. See serialize.
     */
    private readonly writes = new Map<string, Promise<void>>();

    constructor(
        private outputChannel: vscode.OutputChannel,
        formatter: ImportFormatter,
    ) {
        this.formatter = formatter;
    }

    /**
     * Runs `write` once every write already queued for `document` has settled,
     * and queues it as the one the next caller waits behind.
     *
     * Each writer reads the document, computes an edit from that text and
     * applies it as three separate steps, so two overlapping writes both
     * compute against the text as it was before either applied, and the second
     * lands at coordinates the first has already invalidated. A WorkspaceEdit
     * carries no document version and applyEdit accepts none, so there is
     * nothing for the apply itself to fail on. Waiting here is what makes the
     * second write read the first one's result.
     *
     * The whole body of a writer has to sit inside `write`, the read included -
     * a read taken before the wait is exactly the stale snapshot this exists to
     * prevent. The spacing pass a writer runs on its own result calls the
     * unserialized applyEmptyLinesAfterImports for the same reason it must:
     * queued here it would wait on the write running it.
     *
     * A document's queue only ever moves on when its applyEdit settles. Nothing
     * times one out, so a write that never settles holds every write behind it.
     */
    private serialize<T>(document: vscode.TextDocument, write: () => Promise<T>): Promise<T> {
        const key = document.uri.toString();
        const previous = this.writes.get(key) ?? Promise.resolve();

        // The queued promise below never rejects, so only the first arm can run
        // today. The second is what keeps that from being load-bearing: a
        // predecessor that failed is a write that is over, not a reason to
        // abandon the queue behind it.
        const run = previous.then(write, write);

        // Settling rather than rejecting, so a failed write does not reject
        // every write queued behind it as well.
        const queued = run.then(
            () => undefined,
            () => undefined,
        );
        this.writes.set(key, queued);

        void queued.then(() => {
            // Only when nothing queued behind this one, which would otherwise
            // lose its predecessor and run against a document still being
            // written.
            if (this.writes.get(key) === queued) {
                this.writes.delete(key);
            }
        });

        return run;
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

    /** The lines a block rebuilds to once `newPaths` join it, sorted as one where the sort is on. */
    private blockReplacementLines(block: ImportBlock, newPaths: string[], preferDotSyntax: boolean, sortAlphabetically: boolean): string[] {
        const existingBlockPaths = block.imports.map((imp) => imp.path);

        let combinedPaths = [...existingBlockPaths, ...newPaths];
        if (sortAlphabetically) {
            combinedPaths = this.formatter.sortImportsByRank(combinedPaths);
        }

        return this.withTrailingComments(
            combinedPaths.map((path) => this.formatter.formatImportStatement(path, preferDotSyntax)),
            this.trailingCommentsByStatement(block.imports, preferDotSyntax),
        );
    }

    /**
     * Chooses which existing import block a new path must be merged into so the
     * ordering holds across the whole file rather than only inside one block.
     *
     * blockReplacementLines sorts the block it rebuilds, so it keeps a new
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
     * Whether `imp` is the pinned import a newly added import of rank `rank`
     * was added for, which forces the new one above it rather than merely
     * preferring it there.
     *
     * This is the one place a newly added import is read as the provider rather
     * than the consumer, and it overrides the written order every other rule
     * here keeps. `diagnosticPositions` is what licenses that override: a
     * diagnostic reported inside this import's own text is the compiler saying
     * it failed to resolve, so whatever is being added for it has to precede
     * it. Form alone cannot say that. A pinned dotted import that already
     * resolves is far commoner - the file compiled before the edit - and
     * against one of those the new import is the consumer, which the written
     * order keeps below it.
     *
     * Where the import carries `columns`, the evidence must start inside them:
     * a statement sharing its line with other code would otherwise take the
     * override from a diagnostic about that other statement, and a false
     * override's failure direction is a file that stops compiling for a
     * diagnostic that was never about this import. The compiler anchors
     * an unresolved-identifier diagnostic to the identifier's own node
     * (CreateGlitchForMissingUsing's call sites, SemanticAnalyzer.cpp:12544,
     * :12864), so a start position is enough to tell the two statements apart.
     * A compiler reporting a whole-line range instead starts it at the head of
     * the line, outside a clause written after a `;`, which refuses the
     * override - the same safe direction.
     *
     * A multi-line pair carries `spanColumns` instead, and the evidence must
     * start at or after its opener: from there to the end of the recorded
     * path on the last line, everything is read as the pair's own text, and a
     * diagnostic before the opener is about the statement written beside it -
     * the same shared-line shape one line taller. Lines strictly inside the
     * span count whole; the pair tolerates a blank or comment line there, and
     * such a line holds no other statement for the evidence to be about. The
     * reach is exactly the recorded path's: where the scan deliberately
     * over-records one (pairPathBelow's classifyContent), `end` reaches past
     * the clause with it, which only ever widens toward the fallback this
     * narrows.
     *
     * Without either field the whole span still counts. That keeps a statement
     * owning its span exactly as sharp as before, and leaves one shape loose:
     * a pinned multi-line braced clause whose closing line carries a statement
     * after the `}` - `}; X := 1` - still takes the override from a diagnostic
     * inside that statement. Its span goes unmeasured today. A statement
     * beside the opener is not the loose case: the scan records no braced
     * span for a line the clause does not head, so nothing there carries the
     * override at all.
     *
     * Still kept to a pinned dotted consumer and a new import that can supply a
     * first segment for it, because the override is only worth the risk that
     * narrowly. The consequence of an upper bound here is refusing every block
     * and writing a standalone line, so widening it fragments a file into
     * import regions to satisfy nothing.
     *
     * @param diagnosticPositions Start positions of the diagnostics that asked
     *   for the new import. Empty where the caller knows of none, and empty
     *   raises no ceiling.
     */
    private couldResolveAgainst(imp: ScannedImport, rank: number, diagnosticPositions: readonly DiagnosticPosition[]): boolean {
        if (this.formatter.importRank(imp.path) !== 2 || rank >= 2) {
            return false;
        }
        const columns = imp.columns;
        if (columns) {
            return diagnosticPositions.some((position) => position.line === imp.startLine && position.character >= columns.start && position.character < columns.end);
        }
        const spanColumns = imp.spanColumns;
        if (spanColumns) {
            return diagnosticPositions.some((position) =>
                position.line === imp.startLine
                    ? position.character >= spanColumns.start
                    : position.line === imp.endLine
                      ? position.character < spanColumns.end
                      : position.line > imp.startLine && position.line < imp.endLine,
            );
        }
        return diagnosticPositions.some((position) => position.line >= imp.startLine && position.line <= imp.endLine);
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
     * Where the imports pinned to their line allow a new `path` to be written.
     * See PinnedBounds.
     */
    private pinnedBounds(pinned: ScannedImport[], classifications: LineClassification[], path: string, diagnosticPositions: DiagnosticPositionsByPath): PinnedBounds {
        const rank = this.formatter.importRank(path);
        const needsScopeAbove = this.formatter.resolvesAgainstScopeAbove(path);
        const positionsForPath = diagnosticPositions.get(path) ?? [];

        let floor = -1;
        let ceiling = -1;
        for (const imp of pinned) {
            // One pinned import raises one bound. Reading it as the consumer
            // and as a possible provider at once would put the floor at or
            // below the ceiling it raised, and blockIsWithin would then refuse
            // every block - including one lying entirely above the ceiling,
            // which satisfies the ceiling and the written order both.
            if (this.couldResolveAgainst(imp, rank, positionsForPath)) {
                ceiling = ceiling === -1 ? imp.startLine : Math.min(ceiling, imp.startLine);
                continue;
            }
            if (!needsScopeAbove) {
                continue;
            }
            // A floor names the line a new import is written below, so a span
            // with no writable line below it bounds nothing. That is the buffer
            // ending inside an unclosed `<#`: every line the comment covers is
            // already in the span, and appending past the last one writes into
            // the comment - where the scan, which skips a line opened inside a
            // block comment, reads the path as absent and adds it again on the
            // next compile.
            //
            // Skipped here rather than dropped from the result, because the
            // floor is the maximum over every pinned import and only this one
            // is unwritable. Zeroing the maximum would discard the floors
            // raised by the pinned imports above it, and carry the new path
            // over one that could be bringing its first segment into scope.
            //
            // Skipped rather than refused, too. Where it was the only floor the
            // path falls back to the block at the top, which is where an
            // absolute path in the same file already goes, and a file holding
            // an unclosed opener does not compile either way. Declining to
            // write it at all is the worse of the two: see the grounded extras
            // in buildOrganizedContent for why an added path that silently
            // lands nowhere is not an option.
            const spanEnd = pinnedSpanEnd(imp, classifications);
            if (spanEnd === classifications.length - 1 && classifications[spanEnd].endsInsideBlockComment) {
                continue;
            }
            floor = Math.max(floor, spanEnd);
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
     *   and only where a diagnostic inside the pinned import's own statement
     *   shows it is the one that failed to resolve: the new import is read as
     *   the provider that import is missing, so it goes above it. The floor is
     *   the opposite reading of the same file - a pinned import further down
     *   could be what the new import resolves through - and the two cannot both
     *   be honoured. Honouring the floor leaves the diagnostic that asked for
     *   the import unfixed, which is the case the override exists for.
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
     * knowingly let through. Refusing a block for an absolute import below it
     * would refuse every block to every relative path, since a grouped file
     * writes one group above another and an absolute import ends up below some
     * relative one either way. The residual is real, and is not the same
     * judgement pinnedBounds makes - a relative path can still land above an
     * absolute import in a later block that could be bringing its first segment
     * into scope, where a pinned absolute import of the same shape would have
     * pushed it below. A pinned line cannot be moved or grouped, so nothing
     * chose that order; the grouping strategy is the user choosing this one.
     *
     * Within one block localFirst no longer carries a digest import below a
     * relative one (ImportFormatter.groupAndFormatImports), which leaves this
     * guard the block that function cannot see. Only that pairing: a strategy
     * preserving written order still emits whatever order the file had.
     */
    private blockKeepsRelativeOrder(importBlocks: ImportBlock[], blockIndex: number, path: string): boolean {
        if (!this.formatter.resolvesAgainstScopeAbove(path)) {
            return true;
        }
        return !importBlocks.some((block, index) => index > blockIndex && block.imports.some((imp) => this.formatter.resolvesAgainstScopeAbove(imp.path)));
    }

    /**
     * A splice writing a run of import statements on their own lines at
     * `line`. Past the end of the document the statements append with no
     * blank line after them: nothing follows the run, so the blank would only
     * add a trailing empty line.
     */
    private insertSplice(line: number, lineCount: number, statements: string[], blankLineAfter: boolean): LineSplice {
        const start = Math.min(line, lineCount);
        const newLines = blankLineAfter && line < lineCount ? [...statements, ""] : [...statements];
        return { start, endExclusive: start, newLines };
    }

    /**
     * A splice rebuilding a block's line range as `newLines`. Each spliced
     * line is written with an ending after it, so a block ending the document
     * gains a trailing break.
     */
    private blockSplice(block: ImportBlock, newLines: string[]): LineSplice {
        return { start: block.start, endExclusive: block.end + 1, newLines };
    }

    /**
     * Groups paths no block can take by the line each has to be written on,
     * starting from the line the site would have used had no import been
     * pinned. Paths wanting the same line are written together.
     */
    private groupByPlacementLine(
        paths: string[],
        desired: number,
        pinned: ScannedImport[],
        classifications: LineClassification[],
        diagnosticPositions: DiagnosticPositionsByPath,
    ): Map<number, string[]> {
        const byLine = new Map<number, string[]>();
        for (const path of paths) {
            const line = this.placementLine(desired, this.pinnedBounds(pinned, classifications, path, diagnosticPositions));
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
     * Read by the one rebuild that hoists into such a block, which both entry
     * points run when consolidating.
     */
    private groundedPaths(pinned: ScannedImport[], movable: ScannedImport[]): Set<string> {
        return new Set(movable.filter((imp) => this.crossesPinnedProvider(pinned, imp)).map((imp) => imp.path));
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
     *
     * @param diagnosticPositionsByStatement The start positions of the diagnostics
     *   that asked for each statement, keyed on the statement as it appears in
     *   `importStatements`. A statement with no entry is placed by the written
     *   order alone; only couldResolveAgainst reads these, to tell a pinned
     *   import that failed to resolve from one that merely looks like it could.
     */
    async addImportsToDocument(document: vscode.TextDocument, importStatements: string[], diagnosticPositionsByStatement?: DiagnosticPositionsByStatement): Promise<boolean> {
        return this.serialize(document, () => this.applyImports(document, importStatements, diagnosticPositionsByStatement));
    }

    /** addImportsToDocument, without the wait for the writes ahead of it. */
    private async applyImports(document: vscode.TextDocument, importStatements: string[], diagnosticPositionsByStatement?: DiagnosticPositionsByStatement): Promise<boolean> {
        logger.info("ImportDocumentEditor", `Adding ${importStatements.length} import statements to document`);

        const config = settingsFor(document.uri);
        const preferDotSyntax = config.get<string>("behavior.importSyntax", "curly") === "dot";
        const preserveImportLocations = config.get<boolean>("behavior.preserveImportLocations", true);
        const sortAlphabetically = config.get<boolean>("behavior.sortImportsAlphabetically", true);
        const importGrouping = config.get<string>("behavior.importGrouping", "none");

        logger.debug("ImportDocumentEditor", `Import statements received:${preserveImportLocations ? " (locations will be preserved)" : ""} Sort: ${sortAlphabetically} Grouping: ${importGrouping}`);
        importStatements.forEach((statement) => {
            logger.debug("ImportDocumentEditor", `- ${statement}`);
        });

        const text = document.getText();

        // Existence is judged from every import, a pinned one included: it is
        // imported, so nothing needs adding for it.
        const existingPaths = new Set<string>(scanModuleImports(text.split(LINE_SPLIT)).map((imp) => imp.path));

        const newImportPaths = new Set<string>();
        // Re-keyed from the statement the caller holds to the path every
        // placement rule works in, and concatenated where two statements
        // share a path: a second diagnostic asking for the same import is
        // further evidence, not a replacement for the first.
        const diagnosticPositionsByPath = new Map<string, DiagnosticPosition[]>();
        importStatements.forEach((imp) => {
            const path = this.formatter.extractPathFromImport(imp);
            if (path && !existingPaths.has(path)) {
                logger.debug("ImportDocumentEditor", `New import needed: ${path}`);
                newImportPaths.add(path);

                const diagnosticPositions = diagnosticPositionsByStatement?.get(imp);
                if (diagnosticPositions?.length) {
                    diagnosticPositionsByPath.set(path, [...(diagnosticPositionsByPath.get(path) ?? []), ...diagnosticPositions]);
                }
            }
        });

        if (newImportPaths.size === 0) {
            logger.debug("ImportDocumentEditor", "No new imports needed, skipping update");
            return true;
        }

        const options: RebuildOptions = { preferDotSyntax, sortAlphabetically, importGrouping, fallbackEol: documentEol(document) };
        const requestedPaths = Array.from(newImportPaths);
        const target = preserveImportLocations
            ? this.buildPreservedContent(text, requestedPaths, options, diagnosticPositionsByPath)
            : this.buildOrganizedContent(text, requestedPaths, options, diagnosticPositionsByPath);

        // Neither builder may answer null here: the paths are non-empty and
        // none is imported yet, so a null is buildPreservedContent refusing
        // colliding splices rather than "nothing to do".
        if (target === null) {
            logger.error("ImportDocumentEditor", "Refusing to update imports: the rebuilt text could not be composed");
            return false;
        }

        return this.applyRebuiltText(document, text, target, requestedPaths, {
            unchanged: "No import changes needed, skipping update",
            refuse: "Refusing to update imports",
            applied: "Successfully updated imports in document",
            failed: "Failed to update imports in document",
            errored: "Error updating imports",
        });
    }

    /**
     * Applies a rebuilt document text as one minimal, line-aligned edit, after
     * the rewrite guard has read the whole text back. True when the target
     * already matches the document.
     *
     * `text` must be the exact string the rebuild read: the splice's offsets
     * are coordinates in it, and reading the document again here would hand
     * them to a buffer an edit may have moved under us.
     */
    private async applyRebuiltText(
        document: vscode.TextDocument,
        text: string,
        target: string,
        requestedPaths: readonly string[],
        messages: { unchanged: string; refuse: string; applied: string; failed: string; errored: string },
    ): Promise<boolean> {
        if (target === text) {
            logger.debug("ImportDocumentEditor", messages.unchanged);
            return true;
        }

        const refusal = verifyOrganizedRewrite(text, target, requestedPaths);
        if (refusal) {
            logger.error("ImportDocumentEditor", `${messages.refuse}: ${refusal}`);
            return false;
        }

        // Null only for equal texts, which the skip above already answered.
        const splice = minimalSplice(text, target)!;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(positionAt(text, splice.start), positionAt(text, splice.end)), splice.newText);

        try {
            const success = await vscode.workspace.applyEdit(edit);
            logger.info("ImportDocumentEditor", success ? messages.applied : messages.failed);

            if (success) {
                await this.applyEmptyLinesAfterImports(document);
            }

            return success;
        } catch (error) {
            logger.error("ImportDocumentEditor", `${messages.errored}: ${error}`, error);
            return false;
        }
    }

    /**
     * The document text with `additionalPaths` written in where the
     * preserve-locations policy puts them: merged into an existing block,
     * added to the author's own grouping, or written on their own line beside
     * the imports each must sit relative to. Every line the policy does not
     * rewrite comes back byte for byte, modulo the one line ending the result
     * is joined with.
     *
     * Returns null when nothing is left to add - every path blank or already
     * imported - and null when the computed splices collide, which is a
     * composition bug the caller must turn into a refused edit rather than
     * apply: the rewrite guard compares paths as a set, so an import written
     * twice by colliding splices would pass it.
     */
    buildPreservedContent(text: string, additionalPaths: string[], options: RebuildOptions, diagnosticPositionsByPath: DiagnosticPositionsByPath = NO_DIAGNOSTIC_POSITIONS): string | null {
        const { preferDotSyntax, sortAlphabetically, importGrouping } = options;
        const eol = detectEol(text) ?? options.fallbackEol ?? "\n";
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

        // The top of the file for everything written below, in place of line 0.
        // See headerLineCount. Every line it covers is comment or blank, so
        // starting here crosses no `using` and changes no resolution order.
        const headerEnd = headerLineCount(classifications);

        const importBlocks: ImportBlock[] = [];
        for (const imp of rewritableImports(scannedImports)) {
            const lastBlock = importBlocks[importBlocks.length - 1];
            if (lastBlock && imp.startLine === lastBlock.end + 1) {
                lastBlock.end = imp.endLine;
                lastBlock.imports.push(imp);
            } else {
                importBlocks.push({ start: imp.startLine, end: imp.endLine, imports: [imp] });
            }
        }

        // Existence is judged from every import, a pinned one included: it is
        // imported, so nothing needs adding for it.
        const existingPaths = new Set<string>(scannedImports.map((imp) => imp.path));
        // Relocation is judged only from the movable ones. Re-emitting a
        // pinned path while its own line necessarily stays put would duplicate
        // the import rather than move it.
        const relocatablePaths = new Set<string>(rewritableImports(scannedImports).map((imp) => imp.path));

        const newImportPaths = new Set<string>(additionalPaths.map((path) => path.trim()).filter((path) => path.length > 0 && !existingPaths.has(path)));
        if (newImportPaths.size === 0) {
            return null;
        }

        const splices: LineSplice[] = [];

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
            let firstLocalBlockIndex = -1;
            let lastLocalBlockIndex = -1;

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
                    firstLocalBlockIndex = firstLocalBlockIndex === -1 ? index : firstLocalBlockIndex;
                    lastLocalBlockIndex = index;
                }
            });

            // localFirst writes the local imports as two groups either side
            // of the digest one (ImportFormatter.groupAndFormatImports), so
            // a file it organized offers two local blocks rather than one.
            // Which of them a new local path belongs in is the question
            // selectTargetBlockIndex already answers: an absolute path
            // needs nothing in scope and goes in the first, a relative one
            // may resolve through anything above it and goes in the last.
            // The two indices coincide under every other strategy, which
            // leaves one local block and the same answer either way.
            const newDigestPaths: string[] = [];
            const newLocalAbsolutePaths: string[] = [];
            const newLocalRelativePaths: string[] = [];

            for (const path of newImportPaths) {
                if (this.formatter.isDigestImport(path)) {
                    newDigestPaths.push(path);
                } else if (this.formatter.resolvesAgainstScopeAbove(path)) {
                    newLocalRelativePaths.push(path);
                } else {
                    newLocalAbsolutePaths.push(path);
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
                        this.blockIsWithin(importBlocks[blockIndex], this.pinnedBounds(pinned, classifications, path, diagnosticPositionsByPath)) &&
                        this.blockKeepsRelativeOrder(importBlocks, blockIndex, path);
                    (canTake ? taken : unhandled).push(path);
                }
                return { taken, unhandled };
            };

            // Collected per block before any splice is made, because the two
            // local routes reach the same block under every strategy but
            // localFirst. Rebuilding that block once per route would leave
            // two replacements over the same lines, and the second would
            // drop what the first added.
            const takenByBlock = new Map<number, string[]>();
            const unhandledPaths: string[] = [];

            for (const [blockIndex, paths] of [
                [digestBlockIndex, newDigestPaths],
                [firstLocalBlockIndex, newLocalAbsolutePaths],
                [lastLocalBlockIndex, newLocalRelativePaths],
            ] as Array<[number, string[]]>) {
                const { taken, unhandled } = splitForBlock(blockIndex, paths);
                if (taken.length > 0) {
                    takenByBlock.set(blockIndex, [...(takenByBlock.get(blockIndex) ?? []), ...taken]);
                }
                // Imports no block took: one with no matching block, and
                // one its matching block cannot hold - because a pinned
                // import keeps it out, or a relative import below it does.
                unhandledPaths.push(...unhandled);
            }

            for (const blockIndex of [...takenByBlock.keys()].sort((a, b) => a - b)) {
                const block = importBlocks[blockIndex];
                splices.push(this.blockSplice(block, this.blockReplacementLines(block, takenByBlock.get(blockIndex)!, preferDotSyntax, sortAlphabetically)));
            }

            if (unhandledPaths.length > 0) {
                const desired = importBlocks.length > 0 ? importBlocks[importBlocks.length - 1].end + 1 : headerEnd;
                for (const [line, paths] of this.groupByPlacementLine(unhandledPaths, desired, pinned, classifications, diagnosticPositionsByPath)) {
                    splices.push(this.insertSplice(line, lines.length, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), importBlocks.length === 0));
                }
            }
        } else if (importGrouping !== "none" && existingPaths.size > 0) {
            // Grouping is wanted and the file has none, so the imports
            // are regrouped in place. A new path a pinned import
            // keeps out of the rebuilt block is written on its own line
            // below that import instead, rather than into a group that
            // sits above it. Only the new paths are asked: this branch
            // sees at most one block (2+ gapped blocks reach the
            // hasGrouping branch above), so every relocated path is
            // already inside the block being rebuilt in place.
            const displacedPaths =
                importBlocks.length > 0
                    ? Array.from(newImportPaths).filter((path) => !this.blockIsWithin(importBlocks[0], this.pinnedBounds(pinned, classifications, path, diagnosticPositionsByPath)))
                    : [];
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
                splices.push(this.blockSplice(firstBlock, groupedImports));

                for (let i = importBlocks.length - 1; i >= 1; i--) {
                    const block = importBlocks[i];
                    splices.push({ start: block.start, endExclusive: block.end + 1, newLines: [] });
                }

                for (const [line, paths] of this.groupByPlacementLine(displacedPaths, firstBlock.end + 1, pinned, classifications, diagnosticPositionsByPath)) {
                    splices.push(this.insertSplice(line, lines.length, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), false));
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
                for (const [line, paths] of this.groupByPlacementLine(allImportsArray, headerEnd, pinned, classifications, diagnosticPositionsByPath)) {
                    splices.push(this.insertSplice(line, lines.length, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), true));
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
                    const bounds = this.pinnedBounds(pinned, classifications, path, diagnosticPositionsByPath);
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
                // past that line the span is comment body or the lines
                // indented under it, neither of which holds a column-0
                // import the scanner would collect - an indented body
                // ends at the first column-0 line of code, which is the
                // earliest a block could start.
                //
                // - A ceiling, which is a pinned import's own line.
                // - floor + 1, reached only when every block was
                //   refused, which for a path with no ceiling means
                //   every block starts at or below the floor. The floor
                //   is the end of a pinned span, so a block starting
                //   at or below it ends before that span begins, and
                //   floor + 1 is past the end of the block.
                //
                // spliceLines still checks, because this argument
                // holds for these two sites alone and a future site
                // joins the splice list without re-reading it.
                for (const index of [...pathsByBlock.keys()].sort((a, b) => a - b)) {
                    const block = importBlocks[index];
                    splices.push(this.blockSplice(block, this.blockReplacementLines(block, pathsByBlock.get(index)!, preferDotSyntax, true)));
                }

                // headerEnd never decides anything here, and is passed
                // so that no site holds a different top of the file: a
                // path with unconstrained bounds finds every block
                // eligible, so an unblocked one always has a floor or a
                // ceiling, and both sit at or below the header's end.
                for (const [line, paths] of this.groupByPlacementLine(unblockedPaths, headerEnd, pinned, classifications, diagnosticPositionsByPath)) {
                    splices.push(this.insertSplice(line, lines.length, this.formatter.groupAndFormatImports(paths, preferDotSyntax, true, importGrouping), true));
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
                const desired = importBlocks.length > 0 ? importBlocks[importBlocks.length - 1].end + 1 : headerEnd;
                const blankLineAfter = importBlocks.length === 0;

                for (const [line, paths] of this.groupByPlacementLine(newImportPathsArray, desired, pinned, classifications, diagnosticPositionsByPath)) {
                    splices.push(this.insertSplice(line, lines.length, this.formatter.groupAndFormatImports(paths, preferDotSyntax, sortAlphabetically, importGrouping), blankLineAfter));
                }
            }
        }

        return spliceLines(text, splices, eol);
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
     * crossesPinnedProvider, pinnedBounds and placementLine.
     *
     * The result keeps the text's own line ending, so rebuilding an already
     * organized document reproduces it byte for byte and organizeImports can
     * skip the edit.
     */
    buildOrganizedContent(text: string, additionalPaths: string[], options: RebuildOptions, diagnosticPositionsByPath: DiagnosticPositionsByPath = NO_DIAGNOSTIC_POSITIONS): string | null {
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
        // in the space its bounds leave, since it has no line of its own to
        // keep. Declining to write it at all would make organizing a file with
        // such an import silently add nothing.
        //
        // The bounds are pinnedBounds', with the path exempted from itself for
        // the reason crossesPinnedProvider gives, so a rebuilt block and a
        // singly placed path read one rule rather than two. No floor means the
        // block takes it: the block sits above every pinned line, so a ceiling
        // alone is already satisfied there. A floored path goes through
        // placementLine, whose ceiling-over-floor precedence is the one
        // conflict rule both entry points share - a diagnostic reaches here
        // whenever the caller has one, and the pinned consumer it names must
        // end up below the path added to resolve it.
        //
        // Keys name the line the run is written above. The header clamp is
        // unreachable today - every bound derives from a pinned code line, and
        // the header holds none - and is kept because the failure it insures
        // against is an extra silently written into the header, which the
        // guard cannot see.
        const topExtraPaths: string[] = [];
        const groundedExtrasByLine = new Map<number, string[]>();
        for (const path of extraPaths) {
            const bounds = this.pinnedBounds(
                pinned.filter((imp) => imp.path !== path),
                classifications,
                path,
                diagnosticPositionsByPath,
            );
            if (bounds.floor === -1) {
                topExtraPaths.push(path);
                continue;
            }
            const line = Math.max(this.placementLine(bounds.floor + 1, bounds), headerEnd);
            groundedExtrasByLine.set(line, [...(groundedExtrasByLine.get(line) ?? []), path]);
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
            const groundedExtras = groundedExtrasByLine.get(index);
            if (groundedExtras) {
                // Grouping is a property of the block at the top, so a run
                // written between two body lines is emitted ungrouped: the
                // separator a strategy puts between its two groups would read
                // as a gap in the code around it.
                //
                // Emitted above the keyed line whether or not that line itself
                // survives the hoist: a floor's own line is pinned and always
                // survives, but a placement one past a hoisted import must not
                // vanish with it.
                body.push(...this.formatter.groupAndFormatImports(groundedExtras, options.preferDotSyntax, options.sortAlphabetically, "none"));
            }
            if (!hoistedLines.has(index)) {
                body.push(lines[index]);
            }
        }
        // A path floored by a span ending the file is keyed one past the last
        // line, which the loop never reaches.
        const trailingExtras = groundedExtrasByLine.get(lines.length);
        if (trailingExtras) {
            body.push(...this.formatter.groupAndFormatImports(trailingExtras, options.preferDotSyntax, options.sortAlphabetically, "none"));
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
    async organizeImports(document: vscode.TextDocument, additionalPaths: string[], diagnosticPositionsByPath: DiagnosticPositionsByPath = NO_DIAGNOSTIC_POSITIONS): Promise<boolean> {
        return this.serialize(document, () => this.applyOrganizedImports(document, additionalPaths, diagnosticPositionsByPath));
    }

    /** organizeImports, without the wait for the writes ahead of it. */
    private async applyOrganizedImports(document: vscode.TextDocument, additionalPaths: string[], diagnosticPositionsByPath: DiagnosticPositionsByPath): Promise<boolean> {
        const config = settingsFor(document.uri);
        const preferDotSyntax = config.get<string>("behavior.importSyntax", "curly") === "dot";
        const sortAlphabetically = config.get<boolean>("behavior.sortImportsAlphabetically", true);
        const importGrouping = config.get<string>("behavior.importGrouping", "none");

        const text = document.getText();
        const organized = this.buildOrganizedContent(
            text,
            additionalPaths,
            {
                preferDotSyntax,
                sortAlphabetically,
                importGrouping,
                fallbackEol: documentEol(document),
            },
            diagnosticPositionsByPath,
        );

        if (organized === null) {
            logger.debug("ImportDocumentEditor", "No import changes needed by organize");
            return true;
        }

        return this.applyRebuiltText(document, text, organized, additionalPaths, {
            unchanged: "No import changes needed by organize",
            refuse: "Refusing to organize imports",
            applied: "Organized imports in document",
            failed: "Failed to organize imports",
            errored: "Error organizing imports",
        });
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
        const config = settingsFor(document.uri);
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
        return this.serialize(document, () => this.applyEmptyLinesAfterImports(document));
    }

    /**
     * ensureEmptyLinesAfterImports, without the wait for the writes ahead of
     * it. This is the one the writers call on their own result: they are
     * already the write at the head of the queue, so waiting would deadlock.
     */
    private async applyEmptyLinesAfterImports(document: vscode.TextDocument): Promise<boolean> {
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

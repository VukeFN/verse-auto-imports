import { ImportFormatter } from "./ImportFormatter";

/**
 * Splits text into lines without keeping the carriage return of a CRLF pair.
 *
 * Split with this wherever a column is later derived from `line.length`: a
 * `"\n"` split leaves a trailing `\r` on every line of a CRLF document, which
 * puts that column one past the end of the line.
 */
export const LINE_SPLIT = /\r?\n/;

/** A module import found in a document, with the line span it occupies. */
export interface ScannedImport {
    /** The module path, e.g. "/Verse.org/Simulation" or "Gadgets.Tools". */
    path: string;
    startLine: number;
    /** Last line of the statement: equal to startLine, or startLine + 1 for the indented pair. */
    endLine: number;
    /**
     * Whether the statement's own text opens a comment whose body is the lines
     * below it. Set by either marker, since their consequence is the same: `<#`
     * leaves a block comment open until a matching `#>`, and `<#>` opens an
     * indented comment over the lines indented past it.
     *
     * What a marker comments out is decided by where it sits, so such a
     * statement may be neither rebuilt nor moved - re-emitting it at a
     * different line makes it swallow lines the author never wrote it around.
     * It stays where it is, with everything else organized around it.
     */
    anchorsCommentBelow: boolean;
    /**
     * Whether rebuilding this statement's lines from `path` would delete text
     * the author wrote, because the span says more than any one path can. A `;`
     * is what makes that possible: it separates statements exactly as a newline
     * does, so one span can hold two.
     *
     * Such a statement is still a real import and still counts as present. Only
     * rewriting is off limits, as for `anchorsCommentBelow`; `rewritableImports`
     * filters on both.
     *
     * Neither value is a promise. `false` means no loss is known, not that none
     * is possible: content the statement patterns cannot lex, such as an
     * unbalanced `'`, ends the capture early, which leaves a remainder over and
     * so pins the line - the reported path is then a prefix of the real one,
     * present but never re-emitted. `true` does not promise every path on the
     * span was recorded either: a `using` glued to an identifier by a comment
     * removed from between them, `using { /A }; Y<# note #>using { /B }`, is not
     * a statement usingPathsOnLine offers. The line is pinned either way, so
     * nothing is deleted; the cost is a path that does not count as present,
     * which lets a writer add a second copy of it.
     */
    rebuildLosesText: boolean;
    /**
     * The comment trailing the statement on its own line, or "" when it has
     * none. For the indented pair this is the comment on the path line, the
     * only one of the two lines that can carry a path and therefore a comment
     * after it.
     *
     * Held here because a rebuild reconstructs the line from `path` and would
     * otherwise discard it, deleting text the author wrote.
     */
    trailingComment: string;
}

/** What one line of a document leaves behind for the line below it. */
interface LineScan {
    /** The block-comment nesting depth the next line starts at. */
    depth: number;
    /** Whether the line carries any text outside a comment. */
    hasCode: boolean;
    /**
     * The line with its comments removed. A statement is not required to open
     * its line - one can follow a `;`, or the `#>` that closes a block comment
     * - so a reader has to search the whole line, and searching the raw line
     * reads a `using` written in trivia as the line's own statement.
     *
     * Nothing is put in a removed comment's place, so text on either side of
     * one joins. That is what the field is for: a comment splicing a token
     * apart, `us<##>ing { /A }`, rejoins into a `using` the search can find,
     * and a missed `using` is the one error its callers cannot survive. Putting
     * a space there instead loses that, and buys only
     * `X := 1<# note #>using { /A }` - a shape two statements with nothing
     * between them do not compile as anyway.
     */
    code: string;
    /**
     * Whether the line holds a `<#>` marker, which makes every line below it
     * indented past it part of the comment it opens.
     */
    opensIndentedComment: boolean;
}

/**
 * Advances `<# ... #>` block-comment nesting across one line, and reports
 * whether anything on the line was code rather than comment text.
 *
 * Three Verse rules decide what counts as an opener:
 *
 * - Block comments nest, so an inner `#>` closes only the innermost `<#`.
 * - `<#>` is the *indented* comment marker, not a block opener. Its body is
 *   the indented lines below it, which the scanner already skips, so the only
 *   thing that matters here is not mistaking it for a `<#` that never closes.
 *   The rest of its line is comment text.
 * - A `#` line comment runs to the end of the line, so a `<#` inside one is
 *   text rather than an opener.
 *
 * Inside a block comment nothing else is special: a `<#` in a string literal
 * really does open a comment in Verse, so no string tracking is needed.
 */
function scanLine(line: string, depth: number): LineScan {
    let nesting = depth;
    let hasCode = false;
    let code = "";
    let i = 0;

    while (i < line.length) {
        if (nesting > 0) {
            if (line.startsWith("<#", i)) {
                nesting += 1;
                i += 2;
            } else if (line.startsWith("#>", i)) {
                nesting -= 1;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }

        if (line.startsWith("<#>", i)) {
            return { depth: nesting, hasCode, code, opensIndentedComment: true };
        }

        if (line[i] === "#") {
            return { depth: nesting, hasCode, code, opensIndentedComment: false };
        }

        if (line.startsWith("<#", i)) {
            nesting += 1;
            i += 2;
            continue;
        }

        if (!/\s/.test(line[i])) {
            hasCode = true;
        }
        code += line[i];
        i += 1;
    }

    return { depth: nesting, hasCode, code, opensIndentedComment: false };
}

function indentWidth(line: string): number {
    return line.length - line.trimStart().length;
}

/** What a line contributes at file scope. */
export type LineKind = "code" | "comment" | "blank";

/** How a line reads once comment structure from above it is accounted for. */
export interface LineClassification {
    kind: LineKind;
    /**
     * Whether the line begins inside a `<# ... #>` block comment opened above
     * it. This is what decides whether the scanner may read the line as an
     * import at all.
     */
    insideBlockComment: boolean;
    /**
     * Whether the comment this line belongs to was opened on an earlier line,
     * as a block-comment body or the indented body of a `<#>` marker. A caller
     * moving a run of comment lines has to know this: a run whose opener stays
     * behind is half a comment, and relocating it either resurrects the region
     * below the opener or strands lines that no longer read as comment text.
     */
    continuesCommentAbove: boolean;
    /**
     * The line with its comments removed. Search the raw line instead and a
     * `using` written in its trivia reads as the line's own statement.
     */
    code: string;
}

/**
 * Classifies every line as code, comment or blank in one pass.
 *
 * Comment structure is a property of everything above a line, so no caller can
 * decide this line by line: a bare `#>` reads as a line comment on its own but
 * is the tail of a block comment when something above it opened one, a line of
 * ordinary prose is comment text under an open `<#`, and an indented line is
 * comment text under a `<#>` marker. Callers here and in ImportDocumentEditor
 * need the same answer, so it is computed once, next to the lexing rules it
 * depends on.
 *
 * Block-comment depth advances across an indented comment's body exactly as it
 * does anywhere else, so the indented body affects `kind` only.
 */
export function classifyLines(lines: string[]): LineClassification[] {
    const classifications: LineClassification[] = new Array(lines.length);
    let depth = 0;
    // The indentation of the `<#>` marker whose body we are inside, if any.
    let indentedCommentIndent: number | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const insideBlockComment = depth > 0;
        const blank = line.trim() === "";

        // An indented comment runs until a line that is neither blank nor
        // indented past its marker. Blank lines do not end it.
        if (indentedCommentIndent !== null && !blank && indentWidth(line) <= indentedCommentIndent) {
            indentedCommentIndent = null;
        }
        const insideIndentedComment = indentedCommentIndent !== null && !insideBlockComment;

        const scan = scanLine(line, depth);
        const kind: LineKind = blank ? (insideBlockComment ? "comment" : "blank") : insideIndentedComment || !scan.hasCode ? "comment" : "code";

        classifications[i] = {
            kind,
            insideBlockComment,
            continuesCommentAbove: insideBlockComment || insideIndentedComment,
            code: scan.code,
        };

        if (!insideBlockComment && !insideIndentedComment && scan.opensIndentedComment) {
            indentedCommentIndent = indentWidth(line);
        }
        depth = scan.depth;
    }

    return classifications;
}

/**
 * Scans document lines for module imports. This is the single scanner behind
 * every import-editing operation so they all agree on what counts as an
 * import:
 *
 * - Only lines at indentation level 0 are candidates. A `using` inside a
 *   module body is module-scoped and must not be collected, moved, or counted
 *   as part of the file's top import block.
 * - Lines inside a `<# ... #>` block comment are skipped. A commented-out
 *   import block sits at column 0 like a live one, so without this every line
 *   in it reads as an import: new imports get written into the comment, a
 *   needed import is judged already present, and organize hoists a
 *   deliberately disabled import back into force.
 * - The indented style (`using:` with the path on the following line) is
 *   consumed as one two-line entry so editing operations never orphan the
 *   path line or lose its path. A pair opened after a `using` statement and a
 *   `;` is consumed as well, but pinned rather than rewritable: its span says
 *   more than any one path can, so a writer rebuilding it deletes what it did
 *   not read. A `using:` following anything that is not itself a `using` is
 *   not an import line at all and is skipped whole.
 * - Content classification (module import vs local-scope using) is delegated
 *   to ImportFormatter.isModuleImport, passing `{ atFileScope: true }` since
 *   every candidate here already sits at column 0. So a bare identifier at
 *   file level, `using { Features }`, counts as a module import (a
 *   same-directory folder-module import): module `using` is legal only at
 *   file level or module-definition body level, so a bare `using` at column 0
 *   can never be a legal local-scope using.
 * - A collected import that itself opens a comment over the lines below it is
 *   flagged with `anchorsCommentBelow`. It is a real import and still counts
 *   as present, but no writer may rebuild or move its line, because where the
 *   marker sits is what decides which lines it comments out.
 * - The comment trailing a statement is kept in `trailingComment` so a writer
 *   that rebuilds the line from `path` can put it back rather than delete it.
 */
export function scanModuleImports(lines: string[]): ScannedImport[] {
    const formatter = new ImportFormatter();
    const imports: ScannedImport[] = [];
    // Computed up front because the main loop cannot see comment structure
    // once it starts skipping lines.
    const classifications = classifyLines(lines);

    // Whether the statement's own text opens a comment over the lines below it:
    // a `<#>` anywhere on the span, or a `<#` the span never closes.
    //
    // Asked of that text alone rather than of what currently sits under it,
    // because a rebuild is free to move the line and hand it a body - sorting
    // an unclosed opener above another import makes it swallow that import, and
    // moving a `<#>` above an indented line makes it swallow that line.
    //
    // A span always starts at depth 0: lines inside a block comment are skipped
    // below, and the `using:` opening an indented pair holds no `#` to open one
    // on the path line. Only depth 0 yields opensIndentedComment, so a `<#>`
    // inside a block comment on the same span cannot be mistaken for a marker.
    const anchorsCommentBelow = (startLine: number, endLine: number): boolean => {
        let depth = 0;
        for (let line = startLine; line <= endLine; line++) {
            const scan = scanLine(lines[line], depth);
            if (scan.opensIndentedComment) {
                return true;
            }
            depth = scan.depth;
        }
        return depth > 0;
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (classifications[i].insideBlockComment) {
            i += 1;
            continue;
        }

        // Indented lines belong to module bodies or function scopes, never to
        // the file-level import block.
        if (line.length === 0 || /^\s/.test(line)) {
            i += 1;
            continue;
        }

        const trimmed = line.trim();
        const code = classifications[i].code.trim();
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

        if (!ImportFormatter.isModuleImport(trimmed, nextLine, { atFileScope: true })) {
            i += 1;
            continue;
        }

        // Indented style: the path lives on the next line; consume both lines
        // as a single entry.
        if (/^using\s*:\s*$/.test(trimmed)) {
            if (nextLine !== undefined && /^\s+\S/.test(nextLine)) {
                const indentedPath = ImportFormatter.stripTrailingComment(nextLine);
                if (indentedPath) {
                    imports.push({
                        path: indentedPath,
                        startLine: i,
                        endLine: i + 1,
                        anchorsCommentBelow: anchorsCommentBelow(i, i + 1),
                        rebuildLosesText: false,
                        trailingComment: ImportFormatter.extractTrailingComment(nextLine),
                    });
                    i += 2;
                    continue;
                }
            }
            // `using:` without indented content is not a usable import; leave it alone
            i += 1;
            continue;
        }

        // The same pair, opened after a `;` rather than at the head of its line.
        // `;` separates definitions in a scope exactly as a newline does, so
        // statements can precede the `using:`. Without this branch such a line
        // falls through to the single-statement branch below, which reports the
        // path before the `;` and a span of one line - and a writer rebuilding
        // that line from that path deletes the `; using:`, stranding its path in
        // the body.
        //
        // Tested against the line's code rather than its raw text. A `$`
        // anchored on the raw line is defeated by any comment after the
        // `using:`, and searching the raw text has the mirror failure:
        // `using { /A } <# note about using:` ends in `using:` inside a comment,
        // and reading that as an opener records the comment text below as a
        // path.
        //
        // Order is load-bearing. A whole-line `using:` matches this tail test
        // too, so the branch above has to keep first refusal or the plain pair
        // changes shape. That branch tests the raw line, which is safe only
        // while isModuleImport gates this loop on the raw text as well:
        // relaxing that gate is what would let the two inputs disagree.
        //
        // Every path the line writes is recorded, because each is imported and
        // none may be written again, and all are pinned, because no writer can
        // reproduce this span from any one of them. Their spans overlap. Writers
        // never see that, because they all read rewritableImports, which
        // excludes a pinned entry; a reader of the unfiltered scan gets the
        // region reported once per path it carries.
        if (/\busing\s*:\s*$/.test(code)) {
            // Every statement written before the pair. The `using:` contributes
            // no path of its own, since neither statement pattern matches it,
            // and a `using:` following something that is not a `using` never
            // reaches here - isModuleImport rejects the line above and it is
            // skipped whole.
            //
            // Counted with usingPathsOnLine because this branch holds first
            // refusal over the one below, so a line ending in `using:` is
            // counted here or nowhere.
            for (const precedingPath of usingPathsOnLine(formatter, code)) {
                imports.push({
                    path: precedingPath,
                    startLine: i,
                    endLine: i,
                    anchorsCommentBelow: anchorsCommentBelow(i, i),
                    rebuildLosesText: true,
                    // Read from the raw line, so where the comment sits
                    // mid-statement this holds the `; using:` after it as well.
                    // Nothing re-emits a pinned entry, and the code has its
                    // comments already removed so it could only answer "none".
                    trailingComment: ImportFormatter.extractTrailingComment(trimmed),
                });
            }

            const indentedPath = nextLine !== undefined && /^\s+\S/.test(nextLine) ? ImportFormatter.stripTrailingComment(nextLine) : "";
            if (!indentedPath) {
                // The `using:` opens nothing usable, but the line still carries
                // a statement this scanner cannot reproduce. Falling through to
                // the single-statement branch would rebuild the line and delete
                // the `; using:`.
                i += 1;
                continue;
            }

            imports.push({
                path: indentedPath,
                startLine: i,
                endLine: i + 1,
                anchorsCommentBelow: anchorsCommentBelow(i, i + 1),
                rebuildLosesText: true,
                trailingComment: ImportFormatter.extractTrailingComment(nextLine),
            });
            i += 2;
            continue;
        }

        // Two complete statements sharing a line, `using { /X }; using { /Y }`.
        // extractPathFromImport reads the statement at the head of what it is
        // given and says nothing about the remainder, so a line read that way
        // is recorded as its first path alone and a rebuild deletes the second
        // statement. All of them recorded, all of them pinned, spans coinciding,
        // for the reasons the branch above gives.
        //
        // Asked of the line's code rather than its raw text, as that branch is.
        // `using { /A } # see using { /B }` writes one statement and mentions
        // another in a comment; searching the raw text finds two, and refuses to
        // organize a plain single-statement line over the words after its `#`.
        //
        // usingPathsOnLine is what allUsingPaths asks, so reader and writer
        // agree on how many statements a line writes. Counting a second way
        // here would be the looser copy its doc warns against, and this caller
        // needs the count exact in both directions.
        const pathsOnLine = usingPathsOnLine(formatter, code);
        if (pathsOnLine.length > 1) {
            for (const linePath of pathsOnLine) {
                imports.push({
                    path: linePath,
                    startLine: i,
                    endLine: i,
                    anchorsCommentBelow: anchorsCommentBelow(i, i),
                    rebuildLosesText: true,
                    // The same comment for each entry, since they share a line.
                    // Nothing re-emits it - that is what being pinned means.
                    trailingComment: ImportFormatter.extractTrailingComment(trimmed),
                });
            }
            i += 1;
            continue;
        }

        // One statement, and the line is rewritable only if that statement is
        // the whole of what it says. What follows a `;` need not be a `using`,
        // and neither branch above counts it, so the leftover is what says a
        // definition after it would be deleted. See textAfterImport for why the
        // question is "what is left over" rather than "where is the `;`".
        //
        // Asked of the line's code, as the two branches above are: a trailing
        // comment is leftover text on the raw line, and pinning on that refuses
        // to organize every annotated import in the file.
        //
        // A line ending in a bare `;` is pinned too, on text that means nothing.
        // The cost is one line left as written; trimming separators away first
        // means being right about which ones mean nothing.
        const path = formatter.extractPathFromImport(trimmed);
        if (path) {
            imports.push({
                path,
                startLine: i,
                endLine: i,
                anchorsCommentBelow: anchorsCommentBelow(i, i),
                rebuildLosesText: formatter.textAfterImport(code) !== "",
                trailingComment: ImportFormatter.extractTrailingComment(trimmed),
            });
        }
        i += 1;
    }

    return imports;
}

/**
 * The subset of scanned imports a writer is allowed to rebuild or move.
 *
 * Every writer reconstructs an import line from its path alone, which is unsafe
 * in two ways: an import whose line opens a comment over the lines below it
 * cannot survive being moved (ScannedImport.anchorsCommentBelow), and one
 * sharing its span with another statement is rebuilt faithfully to its own path
 * while the rest of the span is deleted (ScannedImport.rebuildLosesText). An
 * excluded import's lines never enter a range a writer replaces, and its path
 * is never re-emitted elsewhere.
 *
 * Such an import is still present for existence and deduplication purposes;
 * only rewriting is off limits. Callers asking "is this path imported" must
 * read the unfiltered scan.
 */
export function rewritableImports(scannedImports: ScannedImport[]): ScannedImport[] {
    return scannedImports.filter((imp) => !imp.anchorsCommentBelow && !imp.rebuildLosesText);
}

/**
 * The path of every `using` written anywhere in a line of live code, in written
 * order, or [] when it writes none.
 *
 * extractPathFromImport reads a statement from the head of what it is given, so
 * a statement that does not open the line is handed its own head rather than
 * the line. That keeps one copy of the two statement patterns instead of a
 * looser second copy that searches, which is what reads a comment as the line's
 * statement.
 *
 * Every `using` is collected rather than the first, because `;` separates
 * definitions in a scope exactly as a newline does. Stopping at the first hides
 * a rank-1 or rank-2 path written after a rank-0 one, and a caller reading an
 * all-absolute answer takes it as permission to remove an import.
 *
 * Only a `using` that begins a token is offered. `using` is a substring of
 * ordinary identifiers - `Housing` holds one - and the dotted pattern needs no
 * space after its `.`, so offering every occurrence of `using { Housing.Data }`
 * reports `Housing.Data` and then `Data`, a path the line does not write, which
 * a caller counting statements reads as two.
 *
 * The cost is a `using` glued to an identifier by a comment removed from
 * between them, `X := 1<# note #>using { /A }`, which this does not report.
 */
function usingPathsOnLine(formatter: ImportFormatter, code: string): string[] {
    const paths: string[] = [];
    for (let at = code.indexOf("using"); at !== -1; at = code.indexOf("using", at + 1)) {
        if (at > 0 && /[A-Za-z0-9_]/.test(code[at - 1])) {
            continue;
        }
        const path = formatter.extractPathFromImport(code.slice(at));
        if (path) {
            paths.push(path);
        }
    }
    return paths;
}

/**
 * The path of every `using` the file writes, at any indentation, module import
 * and local-scope using alike.
 *
 * scanModuleImports skips indented lines on purpose: only a column-0 statement
 * belongs to the file-level import block a writer rebuilds. A caller asking the
 * different question "could anything in this file be resolving against an import
 * I am about to stop writing at the top" needs the indented ones too, because a
 * `using` in a module-definition body is a real import that resolves its own
 * path against what is in scope above it.
 *
 * Deliberately no module-import classification. ImportFormatter.isModuleImport
 * separates the two meanings of `using` by content plus position, and its
 * atFileScope means column 0 *or* directly inside a module-definition body -
 * which indentation alone cannot tell apart from a function body, so reading it
 * off the leading whitespace silently drops a bare module import written inside
 * a module. A caller weighing whether removing an import is safe does not need
 * the distinction anyway: an absolute path is always a module import, and any
 * other `using`, of either meaning, is reason enough not to remove anything.
 *
 * A missed `using` is the one error this must not make, because the caller
 * reads an empty answer as permission to remove an import. Everything here
 * fails towards reporting a path rather than away from it:
 *
 * - Only whole comment lines are skipped, so a commented-out `using` does not
 *   count while one sharing a line with comment trivia still does.
 * - The statement need not open its line - it can follow a `;`, the `#>` that
 *   closes a block comment, or closed inline trivia - so the whole line is
 *   searched. The line searched is the classifier's `code` rather than the raw
 *   text, or a `using { X }` written in a comment stands in for the line's own
 *   statement.
 * - A line contributes every `using` usingPathsOnLine finds on it, in written
 *   order, rather than the first.
 * - A `using:` opening an indented pair is recognised at the end of its line
 *   rather than as the whole of it, since a statement can precede it there too.
 *   The pair is the one shape counted once, because its path is read here from
 *   the line below.
 *
 * Positions are not reported; a caller that needs them wants scanModuleImports.
 */
export function allUsingPaths(lines: string[]): string[] {
    const formatter = new ImportFormatter();
    const classifications = classifyLines(lines);
    const paths: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const { kind, code } = classifications[i];
        if (kind === "comment") {
            continue;
        }

        const trimmed = code.trim();
        paths.push(...usingPathsOnLine(formatter, trimmed));

        // A `using:` opening an indented pair carries no path of its own -
        // extractPathFromImport reads neither pattern out of it - so the path
        // below it is read here instead.
        //
        // Only the tail of the line has to match, because a statement can
        // precede the `using:`. Requiring the whole line drops the path below
        // such a pair, which the caller reads as permission to remove an
        // import; matching the tail alone errs the safe way, since a line
        // merely ending in `using:` contributes the text below it as a path and
        // can only make the caller decline to tidy.
        //
        // The indented half holds no `using` of its own, so the loop reaching
        // it adds no second copy of the path.
        if (!/\busing\s*:\s*$/.test(trimmed)) {
            continue;
        }

        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
        const indentedPath = nextLine !== undefined && /^\s+\S/.test(nextLine) ? ImportFormatter.stripTrailingComment(nextLine) : "";
        if (indentedPath) {
            paths.push(indentedPath);
        }
    }

    return paths;
}

/** An import statement a path conversion may act on, with the line it occupies. */
export interface ConvertibleImport {
    /** The statement text, trimmed, exactly as it appears on its line. */
    statement: string;
    line: number;
}

/**
 * The import statements a path conversion may act on, so the CodeLens provider
 * and the converter cannot disagree about which lines those are.
 *
 * Conversion reads a statement's path, rewrites the whole line around it, and
 * offers a lens on it, so the set is narrower than the full scan in three ways:
 *
 * - Membership comes from scanModuleImports, which already rejects a `using`
 *   inside a `<# ... #>` block comment and one indented inside a module body.
 *   Deriving it line by line instead offers a lens on inert text and on a
 *   module-scoped import, and acting on that lens edits a line inside a
 *   comment.
 * - An import that opens a comment over the lines below it is excluded:
 *   rebuilding its line moves the marker away from the lines it was written
 *   around, and for a `<#` drops the opener and resurrects the region below.
 * - The indented style (`using:` with the path on the following line) is
 *   excluded, because every conversion path identifies an import by a single
 *   line of statement text and replaces that one line.
 */
export function scanConvertibleImports(lines: string[]): ConvertibleImport[] {
    return rewritableImports(scanModuleImports(lines))
        .filter((imp) => imp.startLine === imp.endLine)
        .map((imp) => ({ statement: lines[imp.startLine].trim(), line: imp.startLine }));
}

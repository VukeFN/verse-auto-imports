import { ImportFormatter } from "./ImportFormatter";

/** A module import found in a document, with the line span it occupies. */
export interface ScannedImport {
    /** The module path, e.g. "/Verse.org/Simulation" or "Gadgets.Tools". */
    path: string;
    /** First line of the statement. */
    startLine: number;
    /** Last line of the statement: equal to startLine, or startLine + 1 for the indented pair. */
    endLine: number;
    /**
     * Whether the statement's own text opens a comment whose body is the lines
     * below it, which pins the statement to the position it was written at.
     *
     * Two markers do this, and their consequences are identical, so they are
     * one flag rather than two:
     *
     * - `<#` leaves a block comment open, making every line below it comment
     *   body until a matching `#>`.
     * - `<#>` opens an indented comment, making every line below it indented
     *   past it comment body.
     *
     * Writers rebuild an import line from `path` alone, so trailing text is
     * restored from `trailingComment` rather than preserved in place. That is
     * enough for an annotation, but not for either marker: what a marker
     * comments out is decided by where it sits, so re-emitting it at a
     * different line makes it swallow lines the author never wrote it around.
     * Such a statement cannot be rewritten or moved: it stays on its own line,
     * with everything else organized around it.
     */
    anchorsCommentBelow: boolean;
    /**
     * Whether rebuilding this statement's lines from `path` would delete text
     * the author wrote, because the span carries a statement `path` cannot
     * reproduce.
     *
     * Every writer reconstructs a span from `path` and `trailingComment`, which
     * is faithful only while the statement is the whole of what its lines say.
     * A `;` breaks that, because it separates statements exactly as a newline
     * does: the span holds another statement as well, and a rebuild from either
     * path alone deletes the other. Such a statement is still a real import and
     * still counts as present - only rewriting is off limits, exactly as for
     * anchorsCommentBelow, and rewritableImports filters on both.
     *
     * `false` is "no loss known", not "provably none". Detection looks for a
     * second `using` on the line, so two shapes carry the same hazard
     * undetected:
     *
     * - a `;` followed by anything that is not a `using` at all,
     *   `using { /X }; MyVal := 5`, where the rebuild deletes the definition
     *   (#235)
     * - `using. /X; using:`, where the dotted statement has no closing
     *   delimiter and swallows the rest of the line into its path, so the pair
     *   is pinned under a path that is not `/X` and `/X` itself goes
     *   unreported - the same weakness usingPathsOnLine documents
     *
     * `true` is likewise not a promise that every path on the span was
     * recorded. A line ending in a `using:` pair reports the statement at its
     * head and the path below, and no statement in between (#233). The line is
     * pinned either way, so nothing is deleted; the cost is a path that does not
     * count as present, which lets a writer add a second copy of it.
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
     * The line with its comments removed. A reader searching a line for a
     * statement it cannot prefix-test needs this: a statement is not required
     * to open its line - one can follow a `;`, or the `#>` that closes a block
     * comment - so the search has to cover the whole line, and searching the
     * raw line finds a `using` written in the trivia.
     *
     * Nothing is put in a removed comment's place, so text on either side of
     * one joins. Whether Verse splits a token there is not something its test
     * corpus settles: comments appear only between tokens throughout
     * Tests/Roundtrip/Comments.versetest, and the one splicing case,
     * `"abc<#def#>ghi" = "abcghi"` in Tests/Literals/String.versetest, is
     * string contents rather than an identifier. Joining is the side to be
     * wrong on: it can only report a `using` this reader would otherwise miss,
     * and missing one is the error its caller cannot survive.
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
 * Three Verse rules decide what counts as an opener, all taken from the
 * language's own lexer and comment round-trip tests:
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
            // Indented comment: the rest of this line is comment text, and so
            // is everything below indented past this line.
            return { depth: nesting, hasCode, code, opensIndentedComment: true };
        }

        if (line[i] === "#") {
            // Line comment: the rest of the line is comment text and cannot
            // open a block.
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

/** The width of a line's leading whitespace, which is its indentation. */
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
     * The line with its comments removed. A reader that searches a line rather
     * than prefix-testing it needs this: search the raw line and a `using`
     * written in its trivia reads as the line's own statement.
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
 * comment text under a `<#>` marker. Both writers here and in
 * ImportDocumentEditor need the same answer, so it is computed once, here,
 * next to the lexing rules it depends on.
 *
 * Block-comment depth advances across an indented comment's body exactly as it
 * does anywhere else, so what the scanner sees is unchanged by this: the
 * indented body affects `kind` only.
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
        // indented past its marker: "everything indented by four spaces on
        // subsequent lines becomes part of the comment", blank lines included.
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
 *   not an import line at all and is skipped whole, as it always was.
 * - Content classification (module import vs local-scope using) is delegated
 *   to ImportFormatter.isModuleImport, passing `{ atFileScope: true }` since
 *   every candidate here already sits at column 0. This means a bare
 *   identifier at file level, e.g. `using { Features }`, is now collected as
 *   a module import (a same-directory folder-module import): module `using`
 *   is only legal at file level or module-definition body level, so a bare
 *   `using` at column 0 can never be a legal local-scope using.
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
    // Computed in one pass up front because comment structure is a property of
    // everything above a line, which the main loop cannot see once it starts
    // skipping. `insideBlockComment` decides whether a line may be read as an
    // import at all, and `code` is what a test searching a line rather than
    // prefix-testing it has to search - see the tail test below.
    const classifications = classifyLines(lines);

    // Whether the statement's own text opens a comment over the lines below it,
    // read from that text alone rather than from what currently sits under it.
    //
    // Both markers are decided the same way: a `<#>` anywhere on the span, or a
    // `<#` the span never closes. Neither depends on there being a body today,
    // because a rebuild is free to move the line and hand it one - sorting an
    // unclosed opener above another import makes it swallow that import, and
    // moving a `<#>` above an indented line makes it swallow that line. The
    // statement is what carries the marker, so the statement is what is asked.
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
        // `;` separates definitions in a scope exactly as a newline does, so a
        // statement can precede the `using:` - which is why allUsingPaths tests
        // the tail of the line rather than the whole of it (#218). Read whole,
        // the line is not a pair at all: it falls through to the single-statement
        // branch below, which reports the path before the `;` and a span of one
        // line, and a writer then rebuilds that line from that path alone -
        // deleting the `; using:` and leaving its path stranded in the body.
        //
        // Tested against the line's code rather than its raw text, for the same
        // reason allUsingPaths is: a `$` anchored on the raw line is defeated by
        // any comment after the `using:`, which puts the line straight back on
        // the mangling path this branch exists to keep it off. Searching the raw
        // text has the mirror failure - `using { /A } <# note about using:` ends
        // in `using:` inside a comment, and reading it as an opener records the
        // comment text below as an import path.
        //
        // Order is load-bearing. A whole-line `using:` matches this tail test
        // too, so the branch above has to keep first refusal or the plain pair
        // changes shape.
        //
        // That branch still tests the raw line, and the two inputs cannot
        // disagree where it runs: isModuleImport gates this loop on the raw text
        // as well, and a line whose raw text is not exactly `using:` matches
        // none of its three patterns - so `using: # note` is refused above and
        // never reaches either branch. The gate is what protects it, not the
        // input choice. Relaxing the gate is what would make the choice matter.
        //
        // Every path the line writes is recorded, because each is imported and
        // none may be written again, and all are pinned, because no writer can
        // reproduce this span from any one of them. Their spans overlap. No
        // writer sees that, because all of them read rewritableImports, which
        // excludes a pinned entry; a reader of the unfiltered scan does, and
        // gets the region reported once per path it carries.
        if (/\busing\s*:\s*$/.test(code)) {
            // The statement before the `;`, when the line writes one. A line
            // whose `using:` follows something that is not a `using` at all
            // never reaches here: isModuleImport rejects it above, so the line
            // is skipped whole and left alone, which is the same outcome by a
            // different route.
            const precedingPath = formatter.extractPathFromImport(code);
            if (precedingPath) {
                imports.push({
                    path: precedingPath,
                    startLine: i,
                    endLine: i,
                    anchorsCommentBelow: anchorsCommentBelow(i, i),
                    rebuildLosesText: true,
                    // Read from the raw line, so on a line whose comment sits
                    // mid-statement this holds the `; using:` after it as well
                    // as the comment. Nothing re-emits it - that is what being
                    // pinned means - and the alternative is worse: the code has
                    // its comments already removed, so it can only ever answer
                    // "none".
                    trailingComment: ImportFormatter.extractTrailingComment(trimmed),
                });
            }

            const indentedPath = nextLine !== undefined && /^\s+\S/.test(nextLine) ? ImportFormatter.stripTrailingComment(nextLine) : "";
            if (!indentedPath) {
                // The `using:` opens nothing usable, exactly as in the branch
                // above - but the line still carries a statement this scanner
                // cannot reproduce, so it is pinned rather than handed to the
                // single-statement branch, which would rebuild it and delete the
                // `; using:`.
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
        // extractPathFromImport below reads the statement at the head of what it
        // is given and says nothing about the remainder, so the line used to be
        // recorded as its first path alone, spanning one line and rewritable -
        // and organizing then rebuilt it from that path, deleting the second
        // statement with no trace left that anything had gone.
        //
        // All of them recorded, all of them pinned, spans coinciding, for the
        // reasons the branch above gives.
        //
        // Asked of the line's code rather than its raw text, as that branch is.
        // `using { /A } # see using { /B }` writes one statement and mentions
        // another in a comment; searching the raw text finds two, and refuses to
        // organize a plain single-statement line over the words after its `#`.
        //
        // usingPathsOnLine is what allUsingPaths asks, so reader and writer now
        // agree on how many statements a line writes. Asking it a second way
        // here would be the looser second copy its doc warns against - and this
        // caller needs the count exact in both directions, which is why that
        // function only offers a `using` that begins a token.
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

        const path = formatter.extractPathFromImport(trimmed);
        if (path) {
            imports.push({
                path,
                startLine: i,
                endLine: i,
                anchorsCommentBelow: anchorsCommentBelow(i, i),
                rebuildLosesText: false,
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
 * Every writer reconstructs an import line from its path alone, so an import
 * whose line also opens a comment over the lines below it has to be excluded
 * from both halves of that: its lines never enter a range a writer replaces,
 * and its path is never re-emitted somewhere else. Anything else relocates the
 * marker so the comment swallows different lines than the author wrote it
 * around, or - for a `<#` - drops it and resurrects the region below. See
 * ScannedImport.anchorsCommentBelow.
 *
 * A statement sharing its span with another one is excluded for the same
 * reason, arrived at from the other direction: there the rebuild is faithful to
 * the path and deletes the rest of the span. See ScannedImport.rebuildLosesText.
 *
 * Such an import is still present for existence and deduplication purposes;
 * only rewriting is off limits. Callers wanting "is this path imported" must
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
 * a statement that does not open the line has to be handed its own head rather
 * than the line. Every `using` on the line is offered in turn, which keeps one
 * copy of the two patterns instead of a looser second copy that searches - the
 * looser copy is what read a comment as the statement in the first place.
 *
 * All of them are collected rather than the first, because a line can carry more
 * than one live statement - `;` separates definitions in a scope exactly as a
 * newline does. Stopping at the first is how a rank-0 path written before a
 * rank-1 or rank-2 one on the same line hid it from the caller, which reads an
 * all-absolute answer as permission to remove an import.
 *
 * A dotted statement has no closing delimiter, so one sharing a line swallows
 * what follows it into its path. That malformed path is reported as well, but
 * the next iteration finds the statement after it and reports that path on its
 * own - which is the guarantee this owes its caller. Reading the swallowed copy
 * is not what makes the line safe; finding the statement inside it again is.
 *
 * Only a `using` that begins a token is offered. `using` is a substring of
 * ordinary identifiers - `Housing` holds one - and the dotted pattern needs no
 * space after its `.`, so `using { Housing.Data }` offered every occurrence
 * reports `Housing.Data` and then `Data }`, a path the line does not write. A
 * caller counting statements reads that as two.
 *
 * The cost is a `using` glued to an identifier by a comment removed from
 * between them, `X := 1<# note #>using { /A }`. Whether Verse splits a token
 * where a comment was is not something its test corpus settles, so this is a
 * shape whose meaning is already unclear; a path invented out of every
 * identifier ending in `using` is not.
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
 * other `using`, of either meaning, is reason enough not to remove anything. So
 * every `using` is reported and the caller judges by rank.
 *
 * Only whole comment lines are skipped - a `<# ... #>` body and the indented
 * body of a `<#>` marker - so a commented-out `using` does not count while one
 * sharing a line with comment trivia still does. A missed `using` is the one
 * error this must not make: the caller reads an empty answer as permission to
 * remove an import, so anything unrecognised has to fail towards reporting a
 * path rather than away from it. That is also why the statement is not required
 * to open its line: it can follow a `;`, the `#>` that closes a block comment,
 * or closed inline trivia. So the whole line is searched - but the line with its
 * comments already removed, which is the classifier's answer rather than
 * anything read off the raw text. Searching the raw text is what let a
 * `using { X }` written in a comment stand in for the line's own statement,
 * the same defect extractPathFromImport itself had.
 *
 * A `;` also means a line can carry more than one statement, so a line
 * contributes every `using` statement usingPathsOnLine finds on it, in written
 * order, rather than the first. Reporting the first was the same error under
 * another name - see that function. For the same reason a `using:` opening an
 * indented pair is recognised at the end of its line rather than as the whole
 * of it: a statement can precede it there too. The pair is the one shape still
 * counted once, because its path is read here from the line below.
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
        // Only the tail of the line has to match. Requiring the whole of it
        // dropped the path below a pair opened after a `;`, and a line left
        // reporting nothing but its absolute statements is read by the caller
        // as permission to remove an import. Matching the tail alone errs the
        // other way: a line merely ending in `using:` contributes the text
        // below it as a path, which can only make the caller decline to tidy.
        //
        // The indented half holds no `using` statement of its own, so the loop
        // reaching it adds no second copy of the path - as scanModuleImports
        // consumes both lines at once.
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
    /** The line the statement occupies. */
    line: number;
}

/**
 * The import statements a path conversion may act on, so the CodeLens provider
 * and the converter cannot disagree about which lines those are.
 *
 * Conversion reads a statement's path, rewrites the whole line around it, and
 * offers a lens on it, so the set is narrower than the full scan in three ways:
 *
 * - It comes from scanModuleImports, which already rejects a `using` inside a
 *   `<# ... #>` block comment and one indented inside a module body. Deriving
 *   membership line by line instead is what let a lens appear on inert text and
 *   on a module-scoped import, and acting on that lens edited a line inside a
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

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
    /**
     * Last line of the statement: equal to startLine, or the line holding the
     * path for the indented pair. That is the first line of code below the
     * opener, which is not always the one directly below it - a blank line or
     * a comment inside the pair does not end it. See indentedPairPathLine.
     */
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
     * only line of the span that can carry a path and therefore a comment
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
     * Nothing is put in a removed comment's place, so text on either side of
     * one joins. That is what the field is for: a comment splicing a token
     * apart, `us<##>ing { /A }`, rejoins into a `using` a search of the whole
     * line can find, and a missed `using` is the one error its callers cannot
     * survive. Putting a space there instead loses that, and buys only
     * `X := 1<# note #>using { /A }` - a shape two statements with nothing
     * between them do not compile as anyway.
     */
    codeWithoutComments: string;
    /**
     * `codeWithoutComments` with the contents of every `"` string replaced by
     * spaces, so a `using` written as string text is not offered as a statement
     * the line makes.
     *
     * Read this wherever a path is going to count as imported. The text of a
     * string is data, not a statement, and recording a path from it both
     * suppresses an import the file needs and - because a path that counts as
     * pinned withholds the movable import of the same path from the rebuilt
     * block - deletes the real `using` the author wrote.
     *
     * A `'` is deliberately not masked, though the lexer opens a char literal
     * on one. The same character closes a path's quoted segment suffix,
     * `Economy.Shop'Loc'`, and masking it truncates the path to `Economy.Shop`,
     * a different module that exists; see ImportFormatter.DOTTED_STATEMENT.
     * Nothing is lost by that, because a char literal holds one character and a
     * `using` cannot fit in one.
     *
     * Spaces rather than nothing, so the text on either side of a string does
     * not join into a token neither side wrote. `codeWithoutComments` removes
     * comments without replacement on purpose, for the opposite reason; the two
     * differ because a comment can splice a token apart and a string cannot.
     *
     * Equal to `codeWithoutComments` on a line that ended inside an open
     * literal or interpolation, which the second lexing pass reads with literal
     * tracking off. Nothing there can be classified, so nothing is masked, and
     * a `using` written in an unterminated string on such a line still counts
     * as present.
     */
    codeOutsideLiterals: string;
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
 * - A bare `#` inside a string or char literal is content, so a line is lexed
 *   far enough to tell the two apart, and no further. A string's `{ ... }`
 *   interpolation holds ordinary code, so the two alternate: a `"` inside one
 *   opens a fresh literal rather than closing the literal around it, and a `#`
 *   written directly in one opens a comment exactly as it would at code scope.
 *   `<#` is the exception in both directions - it really does open a comment
 *   inside a string, so it is read before the literal state is consulted, and a
 *   literal survives across the comment written into it.
 *
 * A line still inside a literal or an interpolation at its end is read again
 * with literals ignored. Nothing could be lexed past the point it was left open
 * - a string may legitimately be open there, since an interpolation block spans
 * lines - so the rest of that line is trivia this cannot classify, and treating
 * it as literal content is what would let a `using` written in a trailing
 * comment read as the line's own statement.
 */
function scanLine(line: string, depth: number): LineScan {
    return lexLine(line, depth, true) ?? lexLine(line, depth, false)!;
}

/** One literal or interpolation open at a point in a line. */
type LexFrame =
    | { kind: "literal"; quote: string }
    /**
     * The `{ ... }` blocks written inside the interpolation, which a `}` has to
     * close before one can close the interpolation itself. Without the count a
     * `}` ending a map or a block, `"a{map{1=>2}}b"`, reads as the end of the
     * interpolation and the string's remaining text is lexed as code.
     */
    | { kind: "interpolation"; braces: number };

/**
 * One pass of scanLine, or null when literal tracking was asked for and the
 * line ended inside a literal or an interpolation.
 *
 * @param trackLiterals false reads a `#` as a comment opener wherever it sits.
 */
function lexLine(line: string, depth: number, trackLiterals: boolean): LineScan | null {
    let nesting = depth;
    let hasCode = false;
    let codeWithoutComments = "";
    let codeOutsideLiterals = "";
    let i = 0;
    // What is open at this point, innermost last, and empty at code scope. A
    // stack rather than one quote because interpolation alternates the two:
    // `"a{F("b")}c"` writes a string inside the interpolation of a string.
    //
    // Kept across the `nesting > 0` branch, because a block comment written
    // inside a string does not end it: `"a<#c#>#b"` is the string `"a#b"`.
    const open: LexFrame[] = [];

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
            return { depth: nesting, hasCode, codeWithoutComments, codeOutsideLiterals, opensIndentedComment: true };
        }

        const innermost = trackLiterals ? open[open.length - 1] : undefined;

        // Inside an interpolation this is code scope again, so a `#` there ends
        // the line as one at the head of it would. Returning the line read so
        // far, rather than null, is what keeps the text before it: the fallback
        // pass ends at the first `#` on the line, which may sit further back
        // inside string text this pass has already read as content.
        if (line[i] === "#" && innermost?.kind !== "literal") {
            return { depth: nesting, hasCode, codeWithoutComments, codeOutsideLiterals, opensIndentedComment: false };
        }

        if (line.startsWith("<#", i)) {
            nesting += 1;
            i += 2;
            continue;
        }

        if (innermost?.kind === "literal") {
            // An escape and the character it escapes are one unit, or `"a\"b"`
            // closes at the quote it escapes and the rest of the line is read
            // as code. `\{` is the same rule, and is what keeps an escaped brace
            // from opening an interpolation.
            if (line[i] === "\\") {
                codeWithoutComments += line.slice(i, i + 2);
                codeOutsideLiterals += innermost.quote === '"' ? "  " : line.slice(i, i + 2);
                i += 2;
                continue;
            }

            if (line[i] === innermost.quote) {
                open.pop();
            } else if (line[i] === "{" && innermost.quote === '"') {
                // Only a `"` string interpolates. A char literal is one
                // character or one escape, so the `{` of `'{'` is content.
                open.push({ kind: "interpolation", braces: 0 });
            }
        } else if (trackLiterals) {
            if (line[i] === '"' || line[i] === "'") {
                open.push({ kind: "literal", quote: line[i] });
            } else if (innermost?.kind === "interpolation") {
                if (line[i] === "{") {
                    innermost.braces += 1;
                } else if (line[i] === "}") {
                    if (innermost.braces > 0) {
                        innermost.braces -= 1;
                    } else {
                        open.pop();
                    }
                }
            }
        }

        if (!/\s/.test(line[i])) {
            hasCode = true;
        }
        codeWithoutComments += line[i];
        // Only a `"` string. A `'` opens a char literal here, but the same
        // character ends a path's quoted segment suffix, `Economy.Shop'Loc'`,
        // and masking that truncates the path to `Economy.Shop` - a different
        // module that exists. Nothing is lost by leaving `'` alone: a char
        // literal holds one character, which cannot be a `using`.
        codeOutsideLiterals += innermost?.kind === "literal" && innermost.quote === '"' ? " " : line[i];
        i += 1;
    }

    return open.length === 0 ? { depth: nesting, hasCode, codeWithoutComments, codeOutsideLiterals, opensIndentedComment: false } : null;
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
     * Search the raw line instead and a `using` written in its trivia reads as
     * the line's own statement.
     */
    codeWithoutComments: string;
    /**
     * `codeWithoutComments` with every literal's contents masked. Read this, not
     * `codeWithoutComments`, wherever a path found on the line is going to count
     * as imported; see LineScan.codeOutsideLiterals.
     */
    codeOutsideLiterals: string;
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
            codeWithoutComments: scan.codeWithoutComments,
            codeOutsideLiterals: scan.codeOutsideLiterals,
        };

        if (!insideBlockComment && !insideIndentedComment && scan.opensIndentedComment) {
            indentedCommentIndent = indentWidth(line);
        }
        depth = scan.depth;
    }

    return classifications;
}

/**
 * The first line of code below `from`, or `-1` where there is none.
 *
 * Blank and comment lines are passed over, because neither ends what a
 * statement above them opened: an indented block runs through both, and so does
 * the whitespace a braced clause may open across.
 */
function firstCodeLineBelow(classifications: LineClassification[], from: number): number {
    for (let line = from + 1; line < classifications.length; line++) {
        if (classifications[line].kind === "code") {
            return line;
        }
    }
    return -1;
}

/**
 * The line holding the path that the `using:` ending line `opener` opens, or
 * `-1` where that line opens no pair.
 *
 * Nothing may be written between the two: the `using:` would be left with no
 * indented body, and the path below it stranded as a bare indented expression.
 * So this is the last line such an opener owns, and a caller placing a new
 * statement has to clear it rather than the opener.
 *
 * The path is the first line of code below the opener rather than the line
 * directly below it, because that is the body the compiler reads. Neither a
 * blank line nor a comment ends an indented block, at any indentation - a
 * comment written back at column 0 leaves the block open, and so does a block
 * comment opened inside it. Only code ends it, and code at column 0 ends it
 * without ever having been the body, so there the opener opens nothing.
 *
 * Asked of the classifications rather than the raw text, for the reason the
 * scan's own tail tests are: a `using:` in a comment is trivia, and one a
 * comment follows on the same line is still an opener.
 *
 * Says nothing about what the path line holds, deliberately. Whether the scan
 * admits that path decides what counts as imported; it does not decide who owns
 * the line, and a pair whose path the classification declines owns its line
 * exactly as one it admits does.
 *
 * `-1` for a line that opens no pair, an opener the file ends on, and an
 * `opener` past the end of the file.
 */
export function indentedPairPathLine(classifications: LineClassification[], opener: number): number {
    if (classifications[opener] === undefined || !/\busing\s*:\s*$/.test(classifications[opener].codeOutsideLiterals.trim())) {
        return -1;
    }

    const pathLine = firstCodeLineBelow(classifications, opener);
    if (pathLine !== -1) {
        // Indentation read from the code, so a line closing a block comment
        // ahead of its statement reads as indented. Harmless in both
        // directions: were that statement really at column 0, the opener
        // opened nothing and the file did not compile to begin with.
        return /^\s/.test(classifications[pathLine].codeWithoutComments) ? pathLine : -1;
    }

    return -1;
}

/**
 * The lines a braced `using` opened on `opener` occupies, with every path
 * written between its braces, or null where the line opens no such span.
 *
 * The braced style is the one import shape whose statement can outlive its
 * line. A macro's braced clause opens across whitespace and line breaks alike,
 * so the `{` may sit below the `using` and the `}` below the path, and inside
 * the braces a line ending separates elements exactly as `;` does. The
 * single-line patterns in ImportFormatter read only the shape that opens and
 * closes on one line, which is why every caller that has to see a span asks
 * this instead of asking them.
 *
 * Read from the classifications rather than the raw text, so a brace written in
 * a comment or inside a string literal closes nothing.
 *
 * Indentation is the caller's question, not this one's: scanModuleImports asks
 * only about column 0, allUsingPaths about every line.
 *
 * Null for the single-line form, whose whole span is the opener - the statement
 * patterns already read it, and offering it here would have a caller count it
 * twice - and null for an unclosed `{`, which no file that compiles writes.
 *
 * @returns the closing brace's line, with the paths the braces hold. More than
 *   one path where the file does not compile: a `using` clause takes a single
 *   path, and a buffer being edited need not compile yet.
 */
function bracedUsingSpan(classifications: LineClassification[], opener: number): { paths: string[]; endLine: number } | null {
    const openerCode = classifications[opener].codeOutsideLiterals.trim();

    // Where the braces begin. On the opener's own line for `using {`, and on
    // the first line of code below it for a `using` whose brace is written
    // there - a line break before the `{` is whitespace to the parser, so both
    // spell the same clause.
    let braceLine: number;
    if (/^using\s*\{/.test(openerCode)) {
        braceLine = opener;
    } else if (/^using$/.test(openerCode)) {
        const below = firstCodeLineBelow(classifications, opener);
        if (below === -1 || !classifications[below].codeOutsideLiterals.trim().startsWith("{")) {
            return null;
        }
        braceLine = below;
    } else {
        return null;
    }

    // The `}` that returns the depth to where the clause opened, with the
    // column it sits at, so the content is cut at that brace rather than at the
    // last one on its line.
    let depth = 0;
    let endLine = -1;
    let closeAt = -1;
    for (let line = braceLine; line < classifications.length && endLine === -1; line++) {
        const code = classifications[line].codeOutsideLiterals;
        for (let column = 0; column < code.length; column++) {
            if (code[column] === "{") {
                depth++;
                continue;
            }
            if (code[column] !== "}") {
                continue;
            }
            depth--;
            if (depth <= 0) {
                endLine = line;
                closeAt = column;
                break;
            }
        }
    }

    // A `}` that is itself comment text closes nothing, so there is no clause
    // here rather than a clause whose last line is trivia. The masking these
    // lines carry removes a comment written on the line; it knows nothing of an
    // indented comment opened above it, which is what can leave the whole
    // closing line inert while still spelling a brace.
    if (endLine === -1 || endLine === opener || classifications[endLine].kind !== "code") {
        return null;
    }

    const braceCode = classifications[braceLine].codeOutsideLiterals;
    const between: string[] = [];
    if (braceLine === endLine) {
        between.push(braceCode.slice(braceCode.indexOf("{") + 1, closeAt));
    } else {
        between.push(braceCode.slice(braceCode.indexOf("{") + 1));
        for (let line = braceLine + 1; line < endLine; line++) {
            // Only code, because a `<#>` written on the opener makes the lines
            // indented past it comment text, and the masking these lines carry
            // knows nothing of a comment opened above them. Counting such a
            // path as imported withholds the import the file actually needs,
            // which is the direction pairPathBelow refuses the same shape in.
            if (classifications[line].kind === "code") {
                between.push(classifications[line].codeOutsideLiterals);
            }
        }
        between.push(classifications[endLine].codeOutsideLiterals.slice(0, closeAt));
    }

    // A line ending and a `;` separate elements alike, and the text arrives
    // here one line to an entry, so splitting on `;` leaves one element each.
    //
    // Content is classified the way pairPathBelow classifies the line under a
    // `using:`, by handing isModuleImport a `using:` and the content as its
    // next line. The two shapes ask the same question - is this bare text a
    // module path - and asking it a second way here is the looser copy that
    // ends with the reader and the writer disagreeing.
    const paths: string[] = [];
    for (const element of between.flatMap((text) => text.split(";"))) {
        const content = element.trim();
        if (content && ImportFormatter.isModuleImport("using:", content, { atFileScope: true })) {
            paths.push(content);
        }
    }

    return { paths, endLine };
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
 * - The indented style (`using:` with the path on a line below it) is consumed
 *   as one entry spanning the opener and that path line, so editing operations
 *   never orphan the path line or lose its path. The path is the first line of
 *   code below the opener rather than the line directly below it, since
 *   neither a blank line nor a comment ends an indented block; a pair holding
 *   one is pinned, because a rebuild from its path would delete what sits
 *   inside the span. A pair opened after a `using` statement and a
 *   `;` is consumed as well, but pinned rather than rewritable: its span says
 *   more than any one path can, so a writer rebuilding it deletes what it did
 *   not read. A pair opened after a definition is consumed and pinned too, by
 *   the reject path below, since the path it opens is imported all the same.
 *   None of the three admits a pair whose path line continues a comment the
 *   opener's own line began - under one it is comment text, and counting it
 *   as imported withholds an import the file needs. They part company on
 *   content: a pair opened after a `using` keeps a path the classification
 *   declines, because its entry is the only one spanning the path line and
 *   dropping it would let a writer split the pair. See pairPathBelow.
 * - The braced style whose `}` closes on a later line is consumed as one entry
 *   spanning the opener and that brace, pinned, since the span holds lines no
 *   rebuild from a path reproduces. Both spellings of it are read, the `{` on
 *   the `using`'s own line and the `{` on the line below, because a line break
 *   before the brace is whitespace to the parser. Without this the span is
 *   invisible whole: the opener fails a classification that needs the closing
 *   brace on one line, and the path between the braces is indented, which the
 *   rule above skips. See bracedUsingSpan.
 * - Content classification (module import vs local-scope using) is delegated
 *   to ImportFormatter.isModuleImport, passing `{ atFileScope: true }` since
 *   every candidate here already sits at column 0. So a bare identifier at
 *   file level, `using { Features }`, counts as a module import (a
 *   same-directory folder-module import): module `using` is legal only at
 *   file level or module-definition body level, so a bare `using` at column 0
 *   can never be a legal local-scope using.
 *   That classification reads the line from its head, so it rejects a line
 *   whose `using` follows a definition. Such a line is not skipped: every
 *   complete `using` statement it writes is recorded, pinned, because the path
 *   is imported and writing it again would duplicate it. The pair a `using:`
 *   opens at the end of such a line is recorded with them, spanning both
 *   lines, on the same ground - the path below it is imported. That tail is
 *   read from the line's code, so a `using:` the classification refused only
 *   for the trivia after it opens a pair here as well.
 * - A path is only ever read from the line's statements, never from the text of
 *   a `"` string it writes. A `'` is not treated as opening literal text here,
 *   because it also closes a path's quoted segment suffix; see
 *   LineScan.codeOutsideLiterals for why that costs nothing.
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

    // The path the indented pair opened on `opener` takes, with the line
    // holding it, or null when the line opens no pair this scan admits.
    //
    // Which line that is comes from indentedPairPathLine: the first line of
    // code below the opener, not the line directly below it, since neither a
    // blank line nor a comment ends an indented block. One home for that rule
    // as well, so the scan and the placement rules built on it cannot disagree
    // about which lines a pair occupies.
    //
    // One home for the comment rule, because all three branches that reach a
    // pair need it and none of them can see it from where it is decided. A
    // path line continuing a comment the opener's own line began,
    // `using: <#>` or an unclosed `<#`, is comment text, and the file does not
    // import it - counting it as present declines the diagnostic asking for
    // it, and the import is never written.
    //
    // That is the test, and not the wider "the path line is live code": a line
    // may hold both, `using: <#` over `note #> /A`, where the comment ends
    // mid-line and code follows it. Declining there costs a duplicate import
    // on a shape nothing writes, where admitting the `<#>` case withholds a
    // needed one.
    //
    // The opener always sits at column 0 outside any comment, since the loop
    // skips every other line before reaching a pair, so a comment continuing
    // onto the path line was opened by the opener itself or by a line inside
    // the pair. Either way the path is comment text and the file does not
    // import it.
    //
    // @param classifyContent whether content isModuleImport declines, such as
    //   the quoted segment suffix `Foo'Loc'`, disqualifies the pair. False for
    //   a pair opened after a complete `using`: the statements before its `;`
    //   are recorded against the opener line alone, so the pair entry is the
    //   only one whose span reaches the path line, and declining it lets a new
    //   relative import be written between the opener and the path it opens -
    //   a statement written there leaves the `using:` with no body. The comment
    //   rule above costs nothing there, because pinnedSpanEnd rebuilds that
    //   reach from the comment structure itself; a content rule has nothing to
    //   rebuild it from. Over-recording the path is the cheaper error: the entry is
    //   pinned, so no writer rebuilds the line, and no diagnostic asks for a
    //   path of this shape.
    //
    //   Not a property of that branch alone. A definition-headed line writing a
    //   complete `using` before its pair, `X := 1; using { /A }; using:`,
    //   strands the path line the same way and still classifies, as it always
    //   has. That is a standing gap rather than one this parameter closes, and
    //   narrowing it here would only move the hole.
    const pairPathBelow = (opener: number, classifyContent: boolean): { path: string; pathLine: number } | null => {
        const pathLine = indentedPairPathLine(classifications, opener);
        if (pathLine === -1 || classifications[pathLine].continuesCommentAbove) {
            return null;
        }
        const text = lines[pathLine];
        if (classifyContent && !ImportFormatter.isModuleImport("using:", text, { atFileScope: true })) {
            return null;
        }
        // Empty where the line carries only a comment, which is no more a
        // usable pair than a missing line is.
        const path = ImportFormatter.stripTrailingComment(text);
        return path ? { path, pathLine } : null;
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
        const codeWithoutComments = classifications[i].codeWithoutComments.trim();
        // Every path recorded below is read from this rather than from
        // `codeWithoutComments`, because every one of them counts as imported.
        // See LineScan.codeOutsideLiterals for what a path read out of string
        // text costs. `codeWithoutComments` still answers what text the line
        // holds, which is a question about the whole line and not about its
        // statements.
        const statements = classifications[i].codeOutsideLiterals.trim();
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

        if (!ImportFormatter.isModuleImport(trimmed, nextLine, { atFileScope: true })) {
            // The classification reads the line from its head, so a `using`
            // written after a definition - `X := 1; using { /A }`, legal because
            // `;` separates definitions in a scope exactly as a newline does -
            // does not head its line and the line is rejected here. Its paths
            // are still imported, and recording them is what stops a diagnostic
            // asking for one writing a second copy above a line already making
            // that import.
            //
            // All pinned, because the line writes a definition no rebuild from
            // a path can reproduce. Their spans coincide, which no writer sees:
            // writers read rewritableImports, which excludes a pinned entry.
            //
            // The gate itself is deliberately left refusing these lines rather
            // than widened to admit them. Everything below it may then keep
            // testing the raw line, as the `using:` branch does - see the note
            // there on why the two inputs have to agree.
            for (const linePath of usingPathsOnLine(formatter, statements)) {
                imports.push({
                    path: linePath,
                    startLine: i,
                    endLine: i,
                    anchorsCommentBelow: anchorsCommentBelow(i, i),
                    rebuildLosesText: true,
                    trailingComment: ImportFormatter.extractTrailingComment(trimmed),
                });
            }

            // The pair such a line opens, `X := 1; using:` over an indented
            // path. The loop above records nothing for it - a `using:` writes
            // no path of its own - and the path is on a line the scan skips,
            // which is what left it uncounted.
            //
            // The tail is read from the line's code, so trivia after the
            // `using:` does not hide it. That admits more than a
            // definition-headed line: the head classification refuses
            // `using: # note` and `using: <#>` for their trivia alone, and
            // both arrive here. What each of them opens is pairPathBelow's
            // question, asked the same way by every branch that reaches a pair.
            //
            // Pinned like everything else the branch records, and for a second
            // reason of its own: the span reaches from the opener to its path,
            // so a rebuild from one path deletes every line between them
            // whatever the head of the first one says.
            //
            // A plain `using:` whose path a blank or comment line separates
            // from it lands here as well, and has to. The gate above reads the
            // line directly below the opener, which for such a pair carries no
            // path, so it refuses the line and the rewritable branch below is
            // never reached - which is what stops a writer rebuilding a span
            // over lines the author wrote inside it.
            const pair = /\busing\s*:\s*$/.test(statements) ? pairPathBelow(i, true) : null;
            if (pair) {
                imports.push({
                    path: pair.path,
                    startLine: i,
                    endLine: pair.pathLine,
                    anchorsCommentBelow: anchorsCommentBelow(i, pair.pathLine),
                    rebuildLosesText: true,
                    trailingComment: ImportFormatter.extractTrailingComment(lines[pair.pathLine]),
                });
                i = pair.pathLine + 1;
                continue;
            }

            // The braced clause this line opens, `using{` over an indented path
            // over its own `}`. The classification refuses the opener - the
            // single-line pattern needs the closing brace on the line it reads -
            // and the path between the braces is indented, so the scan skips
            // that too. The whole span goes uncounted, and a writer then adds a
            // second copy of a path the file already imports.
            //
            // Pinned, like everything else this branch records. The span holds
            // lines no rebuild from one path reproduces: the braces may sit
            // around a comment or a blank line the author wrote, and collapsing
            // the span onto a single line is a rewrite nothing asked for.
            // Counting the path is what the duplicate needed.
            const braced = bracedUsingSpan(classifications, i);
            if (braced) {
                for (const bracedPath of braced.paths) {
                    imports.push({
                        path: bracedPath,
                        startLine: i,
                        endLine: braced.endLine,
                        anchorsCommentBelow: anchorsCommentBelow(i, braced.endLine),
                        rebuildLosesText: true,
                        // The opener's own comment. Nothing re-emits a pinned
                        // entry, and the path sits on a line inside the braces
                        // rather than after the statement.
                        trailingComment: ImportFormatter.extractTrailingComment(trimmed),
                    });
                }
                // Resumed *on* the closing line, not past it. A `;` separates
                // statements exactly as a newline does, so `}; using { /B }`
                // writes an import after the clause closes, and stepping over
                // that line loses it - which is this branch's own failure,
                // a path that does not count as present and is then written
                // a second time. Only the lines between the braces are
                // consumed here; the closing line is read like any other.
                i = braced.endLine;
                continue;
            }

            i += 1;
            continue;
        }

        // Indented style: the path lives on the line below; consume the pair as
        // a single entry.
        //
        // Only a pair whose path sits directly below its opener reaches here,
        // so this is the one branch whose entry is rewritable: the span holds
        // the two lines a rebuild re-emits and nothing else. A pair with a
        // blank or comment line inside it is refused by the gate above and
        // recorded there instead, pinned.
        //
        // Neither half of what pairPathBelow refuses can arrive here: reaching
        // this branch needs the raw line to be `using:` and nothing else, which
        // holds no marker to comment out the line below, and the gate above has
        // already put that same line and the same one below it through the same
        // classifier. Asked anyway, so what a pair admits has one answer rather
        // than one this branch happens to agree with.
        if (/^using\s*:\s*$/.test(trimmed)) {
            const pair = pairPathBelow(i, true);
            if (pair) {
                imports.push({
                    path: pair.path,
                    startLine: i,
                    endLine: pair.pathLine,
                    anchorsCommentBelow: anchorsCommentBelow(i, pair.pathLine),
                    rebuildLosesText: false,
                    trailingComment: ImportFormatter.extractTrailingComment(lines[pair.pathLine]),
                });
                i = pair.pathLine + 1;
                continue;
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
        if (/\busing\s*:\s*$/.test(statements)) {
            // Every statement written before the pair. The `using:` contributes
            // no path of its own, since neither statement pattern matches it,
            // and a `using:` following something that is not a `using` never
            // reaches here - isModuleImport rejects the line above, which
            // records the complete statements it writes but not the path its
            // `using:` opens below.
            //
            // Counted with usingPathsOnLine because this branch holds first
            // refusal over the one below, so a line ending in `using:` is
            // counted here or nowhere.
            for (const precedingPath of usingPathsOnLine(formatter, statements)) {
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

            // A complete `using` at the head of the line is what carries it
            // past the gate above, so the trivia that gate refuses a
            // definition-headed line for rides along - `using { /A }; using: <#>`
            // arrives here with its `<#>` intact, commenting out the path line
            // below it. pairPathBelow is what declines that, on the same terms
            // every other branch gets.
            //
            // Content is the one question this branch answers differently, and
            // deliberately; see pairPathBelow's `classifyContent`.
            const pair = pairPathBelow(i, false);
            if (!pair) {
                // The `using:` opens nothing this scan admits, but the line
                // still carries a statement this scanner cannot reproduce.
                // Falling through to the single-statement branch would rebuild
                // the line and delete the `; using:`.
                i += 1;
                continue;
            }

            imports.push({
                path: pair.path,
                startLine: i,
                endLine: pair.pathLine,
                anchorsCommentBelow: anchorsCommentBelow(i, pair.pathLine),
                rebuildLosesText: true,
                trailingComment: ImportFormatter.extractTrailingComment(lines[pair.pathLine]),
            });
            i = pair.pathLine + 1;
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
        const pathsOnLine = usingPathsOnLine(formatter, statements);
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
                rebuildLosesText: formatter.textAfterImport(codeWithoutComments) !== "",
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
 * The scanned imports staying on the line they were written on, for either
 * reason - the complement of rewritableImports.
 *
 * Kept beside it so the two halves of the partition are edited together. A
 * reader that collects one pin reason and not the other sees an import that is
 * in no block, because blocks are built from the rewritable ones, and in no list
 * of its own either.
 */
export function pinnedImports(scannedImports: ScannedImport[]): ScannedImport[] {
    return scannedImports.filter((imp) => imp.anchorsCommentBelow || imp.rebuildLosesText);
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
 *   searched. The line searched is the classifier's `codeWithoutComments`
 *   rather than the raw text, or a `using { X }` written in a comment stands in
 *   for the line's own statement.
 * - A line contributes every `using` usingPathsOnLine finds on it, in written
 *   order, rather than the first.
 * - A braced clause whose `}` closes on a later line contributes the paths
 *   between its braces. No line of that span writes a `using` statement holding
 *   them, so nothing else here would offer them. See bracedUsingSpan.
 * - A `using:` opening an indented pair is recognised at the end of its line
 *   rather than as the whole of it, since a statement can precede it there too.
 *   The pair is the one shape counted once, because its path is read from the
 *   line indentedPairPathLine names: the first line of code below the opener,
 *   which is not always the line directly below it.
 *
 *   That helper carries the comment rule with it, so the pair is the one shape
 *   this reports less of than the raw text would - a path the opener comments
 *   out is not offered. Safe, for a reason the rest of the list cannot use:
 *   comment text is not a `using`, so nothing resolves against it and removing
 *   an import it appeared to provide strands nothing. Reading a pair any other
 *   way here means a second opinion about what a pair is, which is the
 *   disagreement sharing the helper exists to end.
 *
 * Positions are not reported; a caller that needs them wants scanModuleImports.
 */
export function allUsingPaths(lines: string[]): string[] {
    const formatter = new ImportFormatter();
    const classifications = classifyLines(lines);
    const paths: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const { kind, codeWithoutComments } = classifications[i];
        if (kind === "comment") {
            continue;
        }

        const trimmed = codeWithoutComments.trim();
        paths.push(...usingPathsOnLine(formatter, trimmed));

        // A braced clause whose `}` closes on a later line writes its path
        // between the braces rather than as a statement of its own, so
        // usingPathsOnLine finds nothing on any line of the span - not on the
        // opener, which holds no path, and not on the path's own line, which
        // holds no `using`. A path this reader misses is what the caller reads
        // as permission to remove an import.
        //
        // No line of the span is stepped over. The lines between the braces
        // write paths and no `using` of their own, so the loop reaching them
        // adds no second copy, and the closing line may write a statement after
        // its `}` that skipping the line would lose - a dropped path being the
        // one error this must not make.
        const braced = bracedUsingSpan(classifications, i);
        if (braced) {
            paths.push(...braced.paths);
        }

        // A `using:` opening an indented pair carries no path of its own -
        // extractPathFromImport reads neither pattern out of it - so the path
        // below it is read here instead.
        //
        // Which line holds it is indentedPairPathLine's question, asked the
        // same way the scan asks it: the first line of code below the opener,
        // since neither a blank line nor a comment ends an indented block.
        // Reading the line directly below instead drops the path of every pair
        // written with one inside it, and a dropped path is what the caller
        // reads as permission to remove an import.
        //
        // The indented half holds no `using` of its own, so the loop reaching
        // it adds no second copy of the path.
        const pathLine = indentedPairPathLine(classifications, i);
        if (pathLine === -1) {
            continue;
        }

        const indentedPath = ImportFormatter.stripTrailingComment(lines[pathLine]);
        if (indentedPath) {
            paths.push(indentedPath);
        }
    }

    return paths;
}

/**
 * One `Name := import(/Path)` module alias, anchored at the head of a statement.
 *
 * The left side is an identifier, optionally carrying a quoted suffix, a
 * `(path:)` qualifier and access specifiers, and the argument is a single
 * absolute path. Two rules are the compiler's own and narrow this: the argument
 * must be a path literal, so a bare, dotted or relative one names no module to
 * alias, and the dotted left side `Outer.Utils` is refused outright
 * (SemanticAnalyzer.cpp AnalyzeImport).
 *
 * Both invocation styles are read, though only `import(...)` is legal prose.
 * The compiler rejects the bracketed form through a failure-semantics check
 * that never inspects the brackets themselves, so the source does not actually
 * show `import[...]` being refused - and guessing wrong in that direction drops
 * an alias, where reading one the compiler would reject only withholds a lens.
 * The qualifier is admitted on the same terms: nothing checks it here.
 *
 * The aliased path is matched but not captured. Nothing may read it - see
 * scanModuleAliases - and a capture is an invitation to.
 */
const MODULE_ALIAS_STATEMENT = /^(?:\([^()]*:\)\s*)?([A-Za-z_][A-Za-z0-9_]*(?:'[^']*')?)(?:\s*<[^<>\n]+>)*\s*:=\s*import\s*(?:\(\s*\/[^\s()[\]]*\s*\)|\[\s*\/[^\s()[\]]*\s*\])$/;

/**
 * The names a file binds to a module with `Name := import(/Path)`, at column 0.
 *
 * The names alone, never the modules they alias. An alias does not bring its
 * module's members into scope - it binds one name to one module - so a file
 * that aliases `/A/B` still needs `using { /A/B }` to use that module's
 * members unqualified, and a diagnostic asking for one is right to. Offering
 * the aliased path here is what invites a reader to treat it as an import
 * already present, which suppresses an import the file needs.
 *
 * What the names are for is the opposite question: which `using` statements
 * name something that is not a module path. An alias is an ordinary identifier
 * rather than a path, so `using { Gfx }` naming an alias is indistinguishable,
 * by content alone, from one naming a same-directory folder module - and a
 * reader that resolves it as a path finds whichever namesake the workspace
 * holds. See scanConvertibleImports.
 *
 * Only this file is read. That is a chosen boundary, not the whole rule: an
 * alias binds in the enclosing module rather than in the file, because a snippet
 * is not a logical scope, so the definition lands in the module every file of
 * the folder module shares and a sibling file's alias resolves here unqualified
 * (Tests/Modules/Import.versetest:33-44, the `assert_valid` block "Importing
 * something in one snippet is also visible in another"). A `using` naming a
 * sibling file's alias is therefore still offered a conversion. Following the
 * rule across files needs a workspace-wide alias scan no line-based reader can
 * make, and the gap is left open deliberately rather than for want of noticing.
 *
 * An alias indented inside a module body is skipped for the opposite reason: it
 * binds in that module, which a column-0 `using` is outside of.
 *
 * Indentation is read from the raw line, as the module-import scan reads it,
 * and not from the code with comments removed. Nothing replaces a removed
 * comment, so a closed one written ahead of the statement,
 * `<# note #>Gfx := import(/A/B)`, leaves the code starting with the space
 * after it and a column-0 alias then reads as indented - which drops it, and a
 * dropped alias is the one error this must not make.
 *
 * Statements are read from the classified code, so an alias inside a comment or
 * written as string text declares nothing, and one following a `;` is found -
 * `;` separates definitions in a scope exactly as a newline does.
 *
 * Failing towards reporting a name is the safe direction: an alias this misses
 * leaves a `using` naming it open to being rewritten as a path, which is the
 * defect, where a name reported in error only withholds a conversion offer.
 */
export function scanModuleAliases(lines: string[]): Set<string> {
    const aliases = new Set<string>();
    const classifications = classifyLines(lines);

    for (let i = 0; i < lines.length; i++) {
        if (classifications[i].kind !== "code" || lines[i].length === 0 || /^\s/.test(lines[i])) {
            continue;
        }
        for (const statement of classifications[i].codeOutsideLiterals.split(";")) {
            const match = statement.trim().match(MODULE_ALIAS_STATEMENT);
            if (match) {
                aliases.add(match[1]);
            }
        }
    }

    return aliases;
}

/**
 * Whether a `using` names something rooted at one of the file's module aliases.
 *
 * The first dotted segment is what carries it: an alias is a module reference,
 * so `Gfx.Sub` names a member module through the alias exactly as `Gfx` names
 * the alias itself, and neither spelling is a path a workspace search may
 * resolve.
 *
 * An absolute path never is: it starts with `/`, which no identifier may, so it
 * resolves from the global registry and names no alias whatever a file declares.
 */
function rootsAtModuleAlias(path: string, aliases: ReadonlySet<string>): boolean {
    if (path.startsWith("/")) {
        return false;
    }
    return aliases.has(path.split(".")[0].trim());
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
 * - A `using` rooted at a module alias the file declares is excluded. Both
 *   directions of the conversion read the statement as a module path, and an
 *   alias is a name rather than a path: going absolute hunts the workspace for
 *   a folder or a `:= module` declaration of that name and writes whichever
 *   namesake it finds, which silently imports a different module than the alias
 *   names. The declaration is the only evidence of which names are aliases, so
 *   no conversion can recover it later. See scanModuleAliases, whose read stops
 *   at this file and so misses a sibling file's declaration.
 */
export function scanConvertibleImports(lines: string[]): ConvertibleImport[] {
    const aliases = scanModuleAliases(lines);
    return rewritableImports(scanModuleImports(lines))
        .filter((imp) => imp.startLine === imp.endLine && !rootsAtModuleAlias(imp.path, aliases))
        .map((imp) => ({ statement: lines[imp.startLine].trim(), line: imp.startLine }));
}

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
            return { depth: nesting, hasCode, opensIndentedComment: true };
        }

        if (line[i] === "#") {
            // Line comment: the rest of the line is comment text and cannot
            // open a block.
            return { depth: nesting, hasCode, opensIndentedComment: false };
        }

        if (line.startsWith("<#", i)) {
            nesting += 1;
            i += 2;
            continue;
        }

        if (!/\s/.test(line[i])) {
            hasCode = true;
        }
        i += 1;
    }

    return { depth: nesting, hasCode, opensIndentedComment: false };
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
        };

        if (!insideBlockComment && !insideIndentedComment && scan.opensIndentedComment) {
            indentedCommentIndent = indentWidth(line);
        }
        depth = scan.depth;
    }

    return classifications;
}

/**
 * Marks, for each line, whether it begins inside a block comment. Computed in
 * one pass up front because a block comment is a property of everything above
 * a line, which the scanner's main loop cannot see once it starts skipping.
 */
function blockCommentMask(lines: string[]): boolean[] {
    return classifyLines(lines).map((classification) => classification.insideBlockComment);
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
 *   path line or lose its path.
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
    const insideBlockComment = blockCommentMask(lines);

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

        if (insideBlockComment[i]) {
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

        const path = formatter.extractPathFromImport(trimmed);
        if (path) {
            imports.push({
                path,
                startLine: i,
                endLine: i,
                anchorsCommentBelow: anchorsCommentBelow(i, i),
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
 * Such an import is still present for existence and deduplication purposes;
 * only rewriting is off limits. Callers wanting "is this path imported" must
 * read the unfiltered scan.
 */
export function rewritableImports(scannedImports: ScannedImport[]): ScannedImport[] {
    return scannedImports.filter((imp) => !imp.anchorsCommentBelow);
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
 * to open its line, and why extractPathFromImport decides rather than a prefix
 * test - a line closing a block comment can carry a live `using` after the `#>`.
 * The cost is that trivia naming a path, such as a trailing `# see using { /B }`,
 * reports it; that only makes the caller more cautious.
 *
 * Positions are not reported; a caller that needs them wants scanModuleImports.
 */
export function allUsingPaths(lines: string[]): string[] {
    const formatter = new ImportFormatter();
    const classifications = classifyLines(lines);
    const paths: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (classifications[i].kind === "comment") {
            continue;
        }

        // The indented half of a `using:` pair is read here from nextLine, and
        // holds no `using` of its own, so the loop reaching it finds nothing and
        // the pair is counted once - as scanModuleImports consumes both at once.
        const trimmed = lines[i].trim();
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
        const path = /^using\s*:\s*$/.test(trimmed)
            ? nextLine !== undefined && /^\s+\S/.test(nextLine)
                ? ImportFormatter.stripTrailingComment(nextLine)
                : ""
            : formatter.extractPathFromImport(trimmed);
        if (path) {
            paths.push(path);
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

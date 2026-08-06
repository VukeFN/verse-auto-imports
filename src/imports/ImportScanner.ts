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
     * Whether the statement's own text leaves a `<#` block comment open, so
     * the lines below it are that comment's body.
     *
     * Writers rebuild an import line from `path` alone, which discards
     * everything trailing on it. For an ordinary trailing comment that only
     * loses annotation text, but dropping a block-comment opener turns the
     * commented-out region below it back into live code and orphans its `#>`.
     * Such a statement cannot be rewritten or moved: it has to stay on its
     * own line, with everything else organized around it.
     */
    opensBlockComment: boolean;
}

/** What one line of a document leaves behind for the line below it. */
interface LineScan {
    /** The block-comment nesting depth the next line starts at. */
    depth: number;
    /** Whether the line carries any text outside a comment. */
    hasCode: boolean;
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

        if (line.startsWith("<#>", i) || line[i] === "#") {
            // Indented comment or line comment: the rest of the line is
            // comment text and cannot open a block.
            return { depth: nesting, hasCode };
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

    return { depth: nesting, hasCode };
}

/** What a line contributes at file scope. */
export type LineKind = "code" | "comment" | "blank";

/** How a line reads once block-comment nesting from above it is accounted for. */
export interface LineClassification {
    kind: LineKind;
    /**
     * Whether the line begins inside a `<# ... #>` block comment opened above
     * it. A caller moving a run of comment lines has to know this: a run whose
     * opener stays behind is half a comment, and relocating it either
     * resurrects the region below the opener or swallows lines the author
     * never commented out.
     */
    insideBlockComment: boolean;
}

/**
 * Classifies every line as code, comment or blank in one pass.
 *
 * Comment structure is a property of everything above a line, so no caller can
 * decide this line by line: a bare `#>` reads as a line comment on its own but
 * is the tail of a block comment when something above it opened one, and a
 * line of ordinary prose is comment text under an open `<#`. Both writers here
 * and in ImportDocumentEditor need the same answer, so it is computed once,
 * here, next to the lexing rules it depends on.
 */
export function classifyLines(lines: string[]): LineClassification[] {
    const classifications: LineClassification[] = new Array(lines.length);
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const insideBlockComment = depth > 0;
        const scan = scanLine(lines[i], depth);
        const kind: LineKind = scan.hasCode ? "code" : !insideBlockComment && lines[i].trim() === "" ? "blank" : "comment";

        classifications[i] = { kind, insideBlockComment };
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
 * - A collected import that itself opens a block comment spanning the lines
 *   below it is flagged with `opensBlockComment`. It is a real import and
 *   still counts as present, but no writer may rebuild its line, because the
 *   opener lives in the trailing text a rebuild discards.
 */
export function scanModuleImports(lines: string[]): ScannedImport[] {
    const formatter = new ImportFormatter();
    const imports: ScannedImport[] = [];
    const insideBlockComment = blockCommentMask(lines);

    // A statement left a block comment open exactly when the line after it
    // starts inside one: every candidate below begins at depth 0, so any depth
    // the next line inherits was opened by the statement's own text. The mask
    // already holds that answer, so nothing has to be re-scanned here.
    const opensBlockComment = (endLine: number): boolean => endLine + 1 < lines.length && insideBlockComment[endLine + 1];

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
                    imports.push({ path: indentedPath, startLine: i, endLine: i + 1, opensBlockComment: opensBlockComment(i + 1) });
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
            imports.push({ path, startLine: i, endLine: i, opensBlockComment: opensBlockComment(i) });
        }
        i += 1;
    }

    return imports;
}

/**
 * The subset of scanned imports a writer is allowed to rebuild or move.
 *
 * Every writer reconstructs an import line from its path alone, so an import
 * whose line also opens a block comment has to be excluded from both halves of
 * that: its lines never enter a range a writer replaces, and its path is never
 * re-emitted somewhere else. Anything else either drops the opener -
 * resurrecting the region below it - or relocates the opener so the comment
 * swallows different lines than the author wrote it around. See
 * ScannedImport.opensBlockComment.
 *
 * Such an import is still present for existence and deduplication purposes;
 * only rewriting is off limits. Callers wanting "is this path imported" must
 * read the unfiltered scan.
 */
export function rewritableImports(scannedImports: ScannedImport[]): ScannedImport[] {
    return scannedImports.filter((imp) => !imp.opensBlockComment);
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
 * - An import that opens a block comment is excluded: rebuilding its line drops
 *   the opener and resurrects the region below it.
 * - The indented style (`using:` with the path on the following line) is
 *   excluded, because every conversion path identifies an import by a single
 *   line of statement text and replaces that one line.
 */
export function scanConvertibleImports(lines: string[]): ConvertibleImport[] {
    return rewritableImports(scanModuleImports(lines))
        .filter((imp) => imp.startLine === imp.endLine)
        .map((imp) => ({ statement: lines[imp.startLine].trim(), line: imp.startLine }));
}

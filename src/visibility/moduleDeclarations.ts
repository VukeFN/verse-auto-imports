/**
 * Finds explicit `X := module` declarations in Verse source, resolved to their
 * in-file module chain and located precisely enough to edit their access
 * specifier in place. No VS Code dependencies.
 *
 * This overlaps ImportPathConverter's declaration regexes, which answer only
 * "does this file declare a module of this name", and ProjectPathScanner's,
 * which records a position but matches one line at a time and reads no
 * quoted suffix.
 */

/**
 * A declaration in any of the three styles a macro body is written in:
 * `module:`, `module { }` with the brace on that line or the next, and the
 * dotted `module. Inner := ...`. `>` is accepted after the keyword alongside
 * them, matching ImportPathConverter.
 *
 * Group 1 is the declared name with any quoted suffix; group 2 is the whole
 * stacked specifier block, of which at most one entry is a visibility.
 */
const MODULE_DECLARATION = /\b([A-Za-z_][A-Za-z0-9_]*(?:'[^']*')?)((?:\s*<[^>]+>)*)\s*:=\s*module\s*[:>{.]/g;

/** The visibility entry inside a stacked specifier block. */
const VISIBILITY_SPECIFIER = /<\s*(public|protected|private|internal|scoped)\b[^>]*>/;

/** A half-open character span in the source text. */
export interface SourceSpan {
    start: number;
    end: number;
}

/** One explicit module declaration, located precisely enough to rewrite. */
export interface ModuleDeclaration {
    /**
     * Declared name, quoted suffix included. The suffix is part of the
     * identifier and appears in the module's Verse path, so stripping it here
     * would stop a declaration matching the path a diagnostic names.
     */
    name: string;

    /** Enclosing module names in this file, outermost first, ending with this one. */
    chain: string[];

    /** One-based line of the declaration, matching ProjectPathNode.sourceLine. */
    line: number;

    /** Where a specifier is inserted when the declaration carries none. */
    insertionPoint: number;

    /** The visibility specifier's span and keyword, absent when the declaration carries none. */
    visibility?: SourceSpan & { keyword: string };
}

/**
 * Every explicit module declaration in the text, in source order.
 *
 * Nesting is read two ways, because the three declaration styles do not agree
 * on how a body opens. A declaration on the same line as the one before it is
 * nested in it, which is what the dotted and same-line brace chains mean;
 * otherwise indentation decides, as it does for the colon style and for a
 * brace opened on the following line. A one-line `module {}` followed by a
 * MORE indented sibling is therefore read as nesting - invalid Verse anyway,
 * and the alternative is tracking brace depth as well.
 *
 * Text inside comments and string literals is masked before matching, so a
 * commented-out declaration is not reported and a `#` inside a string does not
 * hide a real one. Both directions matter to the caller: a declaration
 * reported where none exists makes it edit dead text and believe the module is
 * declared, and one missed makes it write a second, possibly conflicting part.
 */
export function findExplicitModuleDeclarations(content: string): ModuleDeclaration[] {
    const declarations: ModuleDeclaration[] = [];
    const searchable = maskCommentsAndStrings(content);
    const pattern = new RegExp(MODULE_DECLARATION.source, "g");
    const lineStarts = buildLineStarts(content);
    const open: { chain: string[]; indent: number; line: number }[] = [];

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(searchable)) !== null) {
        const [, name, specifierBlock] = match;
        const nameStart = match.index;
        const line = lineOf(lineStarts, nameStart);
        const indent = indentOf(content, lineStarts[line - 1]);
        while (open.length > 0 && open[open.length - 1].line !== line && indent <= open[open.length - 1].indent) {
            open.pop();
        }

        const chain = open.length > 0 ? [...open[open.length - 1].chain, name] : [name];
        open.push({ chain, indent, line });

        const nameEnd = nameStart + name.length;
        const declaration: ModuleDeclaration = {
            name,
            chain,
            line,
            insertionPoint: nameEnd,
        };

        // The specifier block starts exactly at the name's end, so an offset
        // inside it is an offset from there.
        const visibility = specifierBlock.match(VISIBILITY_SPECIFIER);
        if (visibility && visibility.index !== undefined) {
            const start = nameEnd + visibility.index;
            declaration.visibility = {
                start,
                end: start + visibility[0].length,
                keyword: visibility[1],
            };
        }

        declarations.push(declaration);
    }

    return declarations;
}

/**
 * The text with every comment replaced by spaces, so offsets still address the
 * original.
 *
 * Verse has three comment forms and they do not compose the way a reader
 * expects, so the order of the tests below is the whole of this function:
 *
 * - `<#>` is the INDENTED comment marker, not a block that closes on the `#>`
 *   inside it. The rest of its line is comment text, and so is every line
 *   indented past it, blank lines included. It must therefore be tested before
 *   `<#`, or a declaration commented out this way reads as live code. A `<#`
 *   written inside its body is still a real opener, and outlives the body.
 * - `<# ... #>` nests, and beats a string literal: a `<#` inside a string
 *   really does open a comment there. Both digraphs are consumed whole, so the
 *   `#` of a `<#` cannot also be read as closing one.
 * - `#` runs to the end of the line, but inside a string it is content. This
 *   is the one place string tracking is needed, and the only reason it is
 *   here.
 *
 * ImportScanner encodes the same three rules for its own line scan. The single
 * quote is deliberately not tracked: it opens a char literal and an
 * identifier's quoted suffix alike, and nothing here can tell the two apart.
 */
function maskCommentsAndStrings(content: string): string {
    const masked = content.split("");
    const lines = content.split("\n");
    let blockDepth = 0;
    let markerIndent: number | null = null;
    let lineStart = 0;

    for (const line of lines) {
        const lineEnd = lineStart + line.length;
        const indent = indentOf(content, lineStart);

        // The marker's body runs while lines stay indented past it; a blank
        // line does not end it. The body is still scanned rather than blanked
        // wholesale, because a block comment opened inside it survives the
        // body's end and swallows what follows.
        if (markerIndent !== null) {
            if (line.trim().length === 0 || indent > markerIndent) {
                blockDepth = blankCommentRange(masked, content, lineStart, lineEnd, blockDepth);
                lineStart = lineEnd + 1;
                continue;
            }
            markerIndent = null;
        }

        let inString = false;

        for (let i = lineStart; i < lineEnd; i++) {
            if (blockDepth > 0) {
                if (content.startsWith("<#", i) || content.startsWith("#>", i)) {
                    blockDepth += content[i] === "<" ? 1 : -1;
                    blank(masked, content, i);
                    blank(masked, content, i + 1);
                    i++;
                    continue;
                }
                blank(masked, content, i);
                continue;
            }

            if (content.startsWith("<#>", i)) {
                markerIndent = indent;
                blankRange(masked, content, i, lineEnd);
                break;
            }

            if (content.startsWith("<#", i)) {
                blockDepth++;
                blank(masked, content, i);
                blank(masked, content, i + 1);
                i++;
                continue;
            }

            if (inString) {
                if (content[i] === "\\") {
                    blank(masked, content, i);
                    i++;
                    if (i < lineEnd) blank(masked, content, i);
                    continue;
                }
                if (content[i] === '"') {
                    inString = false;
                }
                blank(masked, content, i);
                continue;
            }

            if (content[i] === '"') {
                inString = true;
                blank(masked, content, i);
                continue;
            }

            if (content[i] === "#") {
                blankRange(masked, content, i, lineEnd);
                break;
            }
        }

        lineStart = lineEnd + 1;
    }

    return masked.join("");
}

/** Replaces one character with a space, keeping newlines so line numbers still hold. */
function blank(masked: string[], content: string, index: number): void {
    if (content[index] !== "\n") {
        masked[index] = " ";
    }
}

/** Blanks a half-open range. */
function blankRange(masked: string[], content: string, start: number, end: number): void {
    for (let i = start; i < end; i++) {
        blank(masked, content, i);
    }
}

/** Blanks a half-open range that is comment text, returning the block-comment depth it leaves behind. */
function blankCommentRange(masked: string[], content: string, start: number, end: number, depth: number): number {
    let blockDepth = depth;

    for (let i = start; i < end; i++) {
        if (content.startsWith("<#", i) || content.startsWith("#>", i)) {
            blockDepth = Math.max(0, blockDepth + (content[i] === "<" ? 1 : -1));
            blank(masked, content, i);
            blank(masked, content, i + 1);
            i++;
            continue;
        }
        blank(masked, content, i);
    }

    return blockDepth;
}

/** Offset of the first character of every line, so a line number is a binary search. */
function buildLineStarts(content: string): number[] {
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
        if (content[i] === "\n") {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** The one-based line an offset falls on. */
function lineOf(lineStarts: readonly number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low + 1;
}

/** Leading whitespace of a line, each tab counted as four spaces so mixed indentation compares. */
function indentOf(content: string, lineStart: number): number {
    let width = 0;
    for (let i = lineStart; i < content.length; i++) {
        if (content[i] === " ") {
            width += 1;
        } else if (content[i] === "\t") {
            width += 4;
        } else {
            break;
        }
    }
    return width;
}

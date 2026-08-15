/**
 * Reading Verse source as text, for the scans that match declarations against
 * it. No VS Code dependencies, so importing this from a pure module is safe -
 * take it by file path rather than through the utils barrel, which re-exports
 * the logger and with it vscode.
 *
 * The comment, string and indentation rules live in verseLexer, which the import
 * scanner reads too. Nothing here re-spells them.
 */

import { LexState, lexVerseLine } from "./verseLexer";

/**
 * The text with every comment, `"` string and char literal replaced by spaces,
 * so offsets still address the original.
 *
 * A line that ends inside an open literal is left masked from the point it
 * opened, rather than re-read with literal tracking off. This reader must fail
 * towards blanking: its callers match declarations against what it returns, and
 * text it wrongly offers as code becomes a declaration one of them edits as if
 * it were real. The import scanner takes the opposite fallback on the same
 * lines, for the opposite reason; see lexVerseLine.
 *
 * A quoted segment suffix is left standing, since it is part of an identifier
 * rather than literal text. Nothing can hide there: the grammar forbids `{`,
 * `}`, `"` and `\` inside one.
 */
export function maskCommentsAndStrings(content: string): string {
    const state: LexState = { depth: 0, markerIndent: null };
    // Split on "\n" alone so a CRLF line keeps its "\r" and the masked line is
    // exactly as long as the line it replaces; joining then rebuilds the file
    // byte for byte.
    return content
        .split("\n")
        .map((line) => {
            const lexed = lexVerseLine(line, state);
            state.depth = lexed.depth;
            state.markerIndent = lexed.markerIndent;
            return lexed.masked;
        })
        .join("\n");
}

/**
 * Leading whitespace width of a whole line, each tab counted as four spaces, for
 * a scan that already holds the line rather than an offset into the file.
 */
export function lineIndentWidth(rawLine: string): number {
    return indentOf(rawLine, 0);
}

/**
 * Pops every open block the line at `indent` has left, so the stack is left
 * holding only the blocks that still enclose it.
 *
 * A block's body is the lines indented past its head, so a line back at or
 * inside the head's own indent closes it. The compiler decides that byte-wise,
 * extending the opening line's whitespace prefix; comparing widths agrees on any
 * consistently indented file and diverges only where tabs and spaces mix inside
 * one body.
 */
export function popClosedBlocks(openBlockIndents: number[], indent: number): void {
    while (openBlockIndents.length > 0 && indent <= openBlockIndents[openBlockIndents.length - 1]) {
        openBlockIndents.pop();
    }
}

/** Leading whitespace of a line, each tab counted as four spaces so mixed indentation compares. */
export function indentOf(content: string, lineStart: number): number {
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

/**
 * The brace depth after the half-open range, starting from the depth before it,
 * with the index where that depth first returned to zero or below.
 *
 * Counted on masked text, so a brace in a comment or a literal contributes none.
 * That is the whole of the rule: a `{` surviving masking is a body's, and the
 * `'{'` and `'\{'` that used to need a special case here are already gone by the
 * time this runs. Nothing may call this on raw source.
 *
 * Both module scans delimit a braced body by this depth, and they must agree:
 * one reads it over the gap between two declarations, the other over a single
 * line, so the range is theirs to choose.
 *
 * @returns `closedAt` is -1 where the depth never returned to zero in the range.
 */
export function scanBraces(searchable: string, start: number, end: number, depth: number): { depth: number; closedAt: number } {
    let braceDepth = depth;
    let closedAt = -1;

    for (let i = start; i < end; i++) {
        const character = searchable[i];
        if (character !== "{" && character !== "}") {
            continue;
        }

        braceDepth += character === "{" ? 1 : -1;

        if (character === "}" && braceDepth <= 0 && closedAt === -1) {
            closedAt = i;
        }
    }

    return { depth: braceDepth, closedAt };
}

/**
 * The brace depth after the half-open range, starting from the depth before it.
 * See {@link scanBraces}, which this reads for callers that need only the depth.
 */
export function countBraces(searchable: string, start: number, end: number, depth: number): number {
    return scanBraces(searchable, start, end, depth).depth;
}

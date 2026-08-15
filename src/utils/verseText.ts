/**
 * Reading Verse source as text, for the scans that match declarations against
 * it. No VS Code dependencies, so importing this from a pure module is safe -
 * take it by file path rather than through the utils barrel, which re-exports
 * the logger and with it vscode.
 *
 * The comment, string and indentation rules live in verseLexer, which the import
 * scanner reads too. Nothing here re-spells them.
 */

import { indentOf, LexState, lexVerseLine } from "./verseLexer";

// Re-exported rather than restated: the width model is the lexer's, and a second
// copy of it here is what ended a `<#>` body on two different lines.
export { indentOf };

/**
 * The text with every comment, `"` string and char literal replaced by spaces,
 * so offsets still address the original.
 *
 * A line that ends inside an unterminated literal is left masked from the point
 * it opened, and the literal does not carry to the line below. This reader must
 * fail towards blanking: its callers match declarations against what it returns,
 * and text it wrongly offers as code becomes a declaration one of them edits as
 * if it were real. The import scanner takes the opposite fallback on the same
 * lines, for the opposite reason; see lexVerseLine.
 *
 * An open interpolation is carried, because it is the one literal state a
 * newline does not end and the file below it is being read wrong otherwise: the
 * `{` of `"Score: {` is inside the literal and blanked, so leaving the matching
 * `}` on the next line at code scope strands the brace depth for the rest of the
 * file. Which states may carry is the lexer's to decide, not this reader's.
 *
 * A quoted segment suffix is left standing, since it is part of an identifier
 * rather than literal text. Nothing can hide there: the grammar forbids `{`,
 * `}`, `"` and `\` inside one.
 */
export function maskCommentsAndStrings(content: string): string {
    const state: LexState = { depth: 0, markerIndent: null, openFrames: [] };
    // Split on "\n" alone so a CRLF line keeps its "\r" and the masked line is
    // exactly as long as the line it replaces; joining then rebuilds the file
    // byte for byte.
    return content
        .split("\n")
        .map((line) => {
            const lexed = lexVerseLine(line, state);
            state.depth = lexed.depth;
            state.markerIndent = lexed.markerIndent;
            state.openFrames = lexed.openFrames;
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

/**
 * The brace depth after the half-open range, starting from the depth before it,
 * with the index where that depth first returned to zero or below.
 *
 * Give it lexed text, never raw source: a brace this counts is one the lexer
 * left standing, and a `#`, a `"` or a `'{'` reaching it unlexed strands the
 * depth for the rest of the file with nothing to recover it. It carries no
 * special case of its own, and may not grow one - a rule about which braces are
 * real belongs to the lexer, where every reader gets it.
 *
 * Neither masked form is balanced unconditionally, so do not read a stranded
 * depth as proof that a brace was missed:
 *
 * - `maskCommentsAndStrings` balances every literal it closes, and cannot
 *   balance one the file never closes. An interpolation does carry across lines
 *   - the language lets one span them - so `"Score: {` over `Points}"` balances,
 *   but the two unclosed cases strand the depth in opposite directions. An
 *   unterminated `"` is masked only to its own line's end and does not carry, so
 *   a `}` the author wrote inside that string on a later line arrives here as a
 *   real one and drives the depth down. An interpolation left open at the end of
 *   the file carries to the end of the file, so the `}` that finally pops it is
 *   blanked and whatever `{` was open outside the string never gets its closer
 *   back. Neither file compiles; a reader here has no way to tell either from a
 *   brace the author really did leave out.
 * - `codeOutsideLiterals` consults only the frame open before each character, so
 *   an interpolation's opening `{` is blanked while its closing `}` survives
 *   even on one line. Callers reading a single line accept that, since a clause
 *   the imbalance closes early was already inside a literal.
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

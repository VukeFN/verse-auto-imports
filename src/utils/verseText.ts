/**
 * Reading Verse source as text, for the scans that match declarations against
 * it. No VS Code dependencies, so importing this from a pure module is safe -
 * take it by file path rather than through the utils barrel, which re-exports
 * the logger and with it vscode.
 */

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
export function maskCommentsAndStrings(content: string): string {
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

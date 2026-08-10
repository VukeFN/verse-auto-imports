/**
 * Renders module declarations into the text of a definitions file. Pure string
 * in, string out - no VS Code dependencies.
 */

/** One module in a chain about to be written, and the specifier it carries. */
export interface DeclarationSpec {
    name: string;

    /**
     * Visibility keyword to declare, or undefined for none. A bare declaration
     * is internal, which is the default anyway: parents are written bare so the
     * file commits nothing beyond the module the importer actually needs.
     */
    specifier?: string;
}

const INDENT = "    ";

/**
 * A nested declaration chain, outermost first, as Verse source without a
 * trailing newline.
 *
 * Every module but the last opens a colon body holding the next one. The last
 * has no body to hold, so it is written in the brace style: `module:` with
 * nothing indented under it does not parse.
 */
export function buildDeclarationBlock(segments: readonly DeclarationSpec[]): string {
    return segments
        .map((segment, depth) => {
            const specifier = segment.specifier ? `<${segment.specifier}>` : "";
            const body = depth === segments.length - 1 ? "module {}" : "module:";
            return `${INDENT.repeat(depth)}${segment.name}${specifier} := ${body}`;
        })
        .join("\n");
}

/**
 * The definitions file's new text, with the block appended and one blank line
 * separating it from whatever was already there.
 *
 * @param existingContent "" when the file does not exist yet
 */
export function appendDeclarationBlock(existingContent: string, block: string): string {
    const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";
    const normalized = block.split("\n").join(eol);
    const existing = existingContent.replace(/\s+$/, "");

    if (existing.length === 0) {
        return `${normalized}${eol}`;
    }

    return `${existing}${eol}${eol}${normalized}${eol}`;
}

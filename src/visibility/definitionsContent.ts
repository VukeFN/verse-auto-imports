/**
 * Renders module declarations into the text of a definitions file. Pure string
 * in, string out - no VS Code dependencies.
 */

import { ModuleDeclaration, SourceSpan } from "./moduleDeclarations";

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
 *
 * @param basePrefix prepended to every line, so the chain can be rendered
 * inside an existing body; the top level passes none.
 */
export function buildDeclarationBlock(segments: readonly DeclarationSpec[], basePrefix = ""): string {
    return segments
        .map((segment, depth) => {
            const specifier = segment.specifier ? `<${segment.specifier}>` : "";
            const body = depth === segments.length - 1 ? "module {}" : "module:";
            return `${basePrefix}${INDENT.repeat(depth)}${segment.name}${specifier} := ${body}`;
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

/**
 * The single text edit that nests a declaration chain inside a declaration the
 * file already carries, or null when that declaration's body is not written in
 * a shape this can extend.
 *
 * Only the two shapes the writer itself emits are extended. A colon body gains
 * the chain as its new first child, indented with the existing body's own
 * prefix - the compiler compares block indentation as a byte-wise prefix, so a
 * copied prefix is the only safe one. An empty-brace body becomes a colon body
 * holding the chain, the conversion writing a child under a leaf always needs.
 * Anything else - the dotted form, a brace body with content, trailing text or
 * a comment on the head line - is somebody's hand-written layout, and editing
 * around it risks rewriting what they meant, so the caller refuses instead.
 *
 * @param anchor must have been read from exactly this content, since its
 * offsets address it.
 */
export function nestDeclarationEdit(existingContent: string, anchor: ModuleDeclaration, segments: readonly DeclarationSpec[]): { span: SourceSpan; text: string } | null {
    const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";

    if (anchor.bodyStyle === ":") {
        return nestIntoColonBody(existingContent, anchor, segments, eol);
    }
    if (anchor.bodyStyle === "{") {
        return convertEmptyBraceBody(existingContent, anchor, segments, eol);
    }
    return null;
}

/** Inserts the chain as the colon body's new first child, before whatever it holds. */
function nestIntoColonBody(content: string, anchor: ModuleDeclaration, segments: readonly DeclarationSpec[], eol: string): { span: SourceSpan; text: string } | null {
    const headLineEnd = content.indexOf("\n", anchor.bodyStart);
    const headTail = content.slice(anchor.bodyStart, headLineEnd === -1 ? content.length : headLineEnd);
    if (!/^[ \t\r]*$/.test(headTail)) {
        return null;
    }

    const anchorPrefix = linePrefix(content, anchor.insertionPoint - anchor.name.length);
    const insertAt = headLineEnd === -1 ? content.length : headLineEnd + 1;
    const childPrefix = bodyPrefix(content, insertAt, anchorPrefix) ?? anchorPrefix + INDENT;

    const block = buildDeclarationBlock(segments, childPrefix).split("\n").join(eol);
    return { span: { start: insertAt, end: insertAt }, text: headLineEnd === -1 ? `${eol}${block}${eol}` : `${block}${eol}` };
}

/**
 * Replaces an empty `{}` body with a colon body holding the chain, colon
 * directly on the keyword as the writer spells it.
 */
function convertEmptyBraceBody(content: string, anchor: ModuleDeclaration, segments: readonly DeclarationSpec[], eol: string): { span: SourceSpan; text: string } | null {
    const body = content.slice(anchor.bodyStart).match(/^[ \t\r\n]*\}/);
    if (!body) {
        return null;
    }
    const braceEnd = anchor.bodyStart + body[0].length;
    const braceLineEnd = content.indexOf("\n", braceEnd);
    const tail = content.slice(braceEnd, braceLineEnd === -1 ? content.length : braceLineEnd);
    if (!/^[ \t\r]*$/.test(tail)) {
        return null;
    }

    let start = anchor.bodyStart - 1;
    while (start > 0 && (content[start - 1] === " " || content[start - 1] === "\t")) {
        start--;
    }
    if (start > 0 && (content[start - 1] === "\n" || content[start - 1] === "\r")) {
        // A brace opening on its own line leaves no head to hang the colon on.
        return null;
    }

    const anchorPrefix = linePrefix(content, anchor.insertionPoint - anchor.name.length);
    const block = buildDeclarationBlock(segments, anchorPrefix + INDENT)
        .split("\n")
        .join(eol);
    return { span: { start, end: braceEnd }, text: `:${eol}${block}` };
}

/** Leading whitespace of the line the offset falls on. */
function linePrefix(content: string, offset: number): string {
    const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
    return content.slice(lineStart).match(/^[ \t]*/)![0];
}

/**
 * The literal indentation of the first non-blank line at or after `from`, or
 * null when there is none or it does not byte-extend the anchor's own prefix -
 * an empty or inconsistently indented body, which no copied prefix can serve.
 */
function bodyPrefix(content: string, from: number, anchorPrefix: string): string | null {
    for (const line of content.slice(from).split("\n")) {
        if (/^[ \t\r]*$/.test(line)) {
            continue;
        }
        const prefix = line.match(/^[ \t]*/)![0];
        return prefix.length > anchorPrefix.length && prefix.startsWith(anchorPrefix) ? prefix : null;
    }
    return null;
}

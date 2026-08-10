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

import { indentOf, maskCommentsAndStrings } from "../utils/verseText";

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

/**
 * The visibility entry inside a stacked specifier block. Group 1 is the keyword
 * alone; the span covers the whole entry, `scoped`'s module list included.
 *
 * A specifier the alternation does not name reads as no specifier at all, and a
 * caller then stacks its own beside the real one - two access specifiers on one
 * definition, which is error 3543. That is why `epic_internal` is here despite
 * being unreachable in user Content.
 */
const VISIBILITY_SPECIFIER = /<\s*(public|protected|private|internal|epic_internal|scoped)\b[^>]*>/;

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

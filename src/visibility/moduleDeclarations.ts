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

import { countBraces, indentOf, maskCommentsAndStrings } from "../utils/verseText";

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

/** One entry of a stacked specifier block, spelled as MODULE_DECLARATION's group 2 spells it. */
const SPECIFIER_ENTRY = /<[^>]+>/g;

/**
 * A visibility entry named by a keyword. Group 1 is the keyword alone; the match
 * covers the whole entry, `scoped`'s module list included.
 *
 * `epic_internal` is here despite being unreachable in user Content, because an
 * entry no branch below recognizes reads as no specifier at all.
 */
const VISIBILITY_KEYWORD = /^<\s*(public|protected|private|internal|epic_internal|scoped)\b[^>]*>$/;

/**
 * A bare `<Identifier>`, which is how a named access level - `Name := scoped{...}`
 * - is written. The compiler resolves the identifier and treats it as an access
 * specifier, so one has to be read as a visibility here too even though no
 * keyword list can reach a user-chosen name.
 *
 * Deliberately only the bare form: an entry carrying arguments or a qualifier
 * cannot be a named access level, and matching it would refuse on ordinary
 * attributes for nothing.
 */
const NAMED_ACCESS_LEVEL = /^<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>$/;

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

    /**
     * The access specifier's span, and its keyword as written, absent when the
     * declaration carries none. A named access level puts a user-chosen
     * identifier here, so this is not always one of the visibility keywords -
     * see findAccessLevel for why it is read as one.
     */
    visibility?: SourceSpan & { keyword: string };
}

/**
 * An enclosing module the scan is still inside, and what will close it.
 *
 * `closeDepth` is the brace depth just outside a braced body, and null when
 * indentation closes the entry instead - the colon, dotted and `>` forms.
 * `line` is held because a declaration sharing its parent's line is inside it,
 * which is what the dotted chain means.
 */
interface OpenModule {
    chain: string[];
    indent: number;
    line: number;
    closeDepth: number | null;
}

/**
 * Every explicit module declaration in the text, in source order.
 *
 * Nesting is read from how each body was opened, because the declaration
 * styles do not agree on what closes one. A braced body ends at the brace
 * returning the depth to where it opened, so its members are free to sit at or
 * left of the declaration's own indent; both brace placements open such a body,
 * the one on the declaration's line and the one on the next. A colon body, and
 * the dotted form, end instead at the first later line back at or left of the
 * declaration. A closing brace takes every module inside its body along,
 * whatever their own indentation would say, so the two are resolved in that
 * order.
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
    const open: OpenModule[] = [];

    // Brace depth at the declaration being read. Counted forward over the gap
    // between one match and the next, so every brace in the file is seen once
    // and a closing brace is never missed for sitting between declarations.
    let braceDepth = 0;
    let counted = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(searchable)) !== null) {
        const [, name, specifierBlock] = match;
        const nameStart = match.index;
        braceDepth = countBraces(searchable, counted, nameStart, braceDepth);
        counted = nameStart;

        const line = lineOf(lineStarts, nameStart);
        const indent = indentOf(content, lineStarts[line - 1]);

        // Closed braced bodies go first, outermost in, because one takes every
        // module inside it along. A colon module written left of the brace's own
        // declaration reads as open on indentation alone, and closing only from
        // the top would let it shield the closed brace beneath it.
        const closedBrace = outermostClosedBrace(open, braceDepth);
        if (closedBrace !== -1) {
            open.length = closedBrace;
        }

        // What is left closes innermost out, and stops at a braced body still
        // waiting for its `}`.
        while (open.length > 0 && closedByIndent(open[open.length - 1], indent, line)) {
            open.pop();
        }

        const chain = open.length > 0 ? [...open[open.length - 1].chain, name] : [name];
        // The terminator is the match's last character. A `{` opens the body
        // from the depth measured here, never the one it produces: the
        // declaration's own braces are a `scoped{...}` list and so balance out,
        // and they are counted on the way to the next match rather than now.
        const closeDepth = match[0].endsWith("{") ? braceDepth : null;
        open.push({ chain, indent, line, closeDepth });

        const nameEnd = nameStart + name.length;
        const declaration: ModuleDeclaration = {
            name,
            chain,
            line,
            insertionPoint: nameEnd,
        };

        // The specifier block starts exactly at the name's end, so an offset
        // inside it is an offset from there.
        const accessLevel = findAccessLevel(specifierBlock);
        if (accessLevel) {
            const start = nameEnd + accessLevel.index;
            declaration.visibility = {
                start,
                end: start + accessLevel.length,
                keyword: accessLevel.keyword,
            };
        }

        declarations.push(declaration);
    }

    return declarations;
}

/**
 * The entry in a stacked specifier block that carries the declaration's access
 * level, its offset inside the block, and its keyword as written.
 *
 * A keyword entry wins wherever both kinds appear, so a block stacking a real
 * visibility onto an unknown attribute still reads as that visibility.
 *
 * An entry that is only a bare identifier is reported rather than passed over,
 * because passing one over is indistinguishable from no specifier at all and a
 * caller then stacks its own beside it - two access levels on one definition,
 * which is error 3543. Callers refuse on every keyword but `public` and
 * `internal`, so an ordinary attribute caught here costs a refusal the user can
 * act on, never a broken edit.
 */
function findAccessLevel(specifierBlock: string): { index: number; length: number; keyword: string } | undefined {
    let named: { index: number; length: number; keyword: string } | undefined;

    for (const entry of specifierBlock.matchAll(SPECIFIER_ENTRY)) {
        const keyword = entry[0].match(VISIBILITY_KEYWORD);
        if (keyword) {
            return { index: entry.index, length: entry[0].length, keyword: keyword[1] };
        }

        if (!named) {
            const identifier = entry[0].match(NAMED_ACCESS_LEVEL);
            if (identifier) {
                named = { index: entry.index, length: entry[0].length, keyword: identifier[1] };
            }
        }
    }

    return named;
}

/**
 * Index of the outermost open module whose braced body has already closed, and
 * so of the first entry the stack no longer holds; -1 while none has closed.
 *
 * Only a braced body can be found closed from below like this. Its depth test
 * holds anywhere in the file, whereas an indent compared across a brace
 * boundary means nothing - a module inside the braces may be written left of
 * the declaration that opened them.
 *
 * The lowest such index is the cut rather than merely one of them, because a
 * braced entry records the depth it opens from and every braced entry left on
 * the stack sits below the current depth: their close depths increase upwards,
 * so nothing below the index found here has closed too. Cutting the stack
 * before the next entry is pushed is what keeps that true.
 */
function outermostClosedBrace(open: readonly OpenModule[], braceDepth: number): number {
    return open.findIndex((entry) => entry.closeDepth !== null && braceDepth <= entry.closeDepth);
}

/**
 * Whether an open module that indentation delimits ends before a declaration at
 * this indent and line. A declaration on the parent's own line is inside it,
 * which is what the dotted chain means.
 *
 * False for a braced body, whose end no indentation can announce. That is what
 * stops the pop loop at one, leaving the modules below it open.
 */
function closedByIndent(open: OpenModule, indent: number, line: number): boolean {
    return open.closeDepth === null && open.line !== line && indent <= open.indent;
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

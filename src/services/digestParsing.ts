/**
 * Pure, VS Code-free parsing of Verse API digest files (`Fortnite.digest.verse`,
 * `Verse.digest.verse`, `UnrealEngine.digest.verse`) into a module-scoped
 * identifier index.
 *
 * The build-time precompiler (`src/scripts/parseDigestFiles.ts`, run under
 * ts-node) is the only caller; its output in `src/data` is what the extension
 * reads. It must never import `vscode` so it can run outside the extension host.
 *
 * The parser tracks indentation like `AssetsDigestParser.parseDigestContent`:
 * modules form a stack scoped by indent, and class/struct/interface/enum bodies
 * are tracked so their members are skipped (only module-scope declarations are
 * importable). Module import paths are resolved from, in precedence order, an
 * explicit `# Module import path:` comment, a scope qualifier `(/path:)`, the
 * enclosing module on the stack, or the file's root domain.
 *
 * Comments are skipped only where `#` is the line's first non-whitespace
 * character. Verse also has `<# #>` and `<#>` comments, and a `#` after code or
 * inside a string is not a comment at all, so this is a narrower rule than the
 * language's. It holds because the digests are machine-generated and carry only
 * whole-line `#` comments; a hand-written file would need the masking that
 * ProjectPathScanner does.
 */

import { lineIndentWidth, popClosedBlocks } from "../utils/verseText";

/** A single importable declaration extracted from a digest file. */
export interface DigestEntry {
    identifier: string;
    modulePath: string;
    type: "class" | "function" | "variable" | "module" | "unknown";
    description?: string;
    isPublic: boolean;
}

/**
 * The result of parsing one digest file: entries keyed by identifier (first
 * occurrence wins) plus an index from module path to the identifiers it exposes.
 */
export interface ParsedDigest {
    entries: Record<string, DigestEntry>;
    moduleIndex: Record<string, string[]>;
}

/** An open module on the indentation stack, holding its resolved import path. */
interface ModuleFrame {
    path: string;
    indent: number;
}

/**
 * A scope qualifier prefix such as `(/Fortnite.com:)` before a declared name.
 * Captures the qualifier path (`/Fortnite.com`). A leading `(` without this shape
 * is a receiver-style extension method (for example `(Prop:creative_prop).Method`),
 * which is out of scope.
 */
const QUALIFIER_RE = /^\((\/[^()]*):\)/;

/**
 * A module-scope declaration head: an identifier, its own specifier groups, and
 * the operator that follows (`:=`, `:`, or `(`). Captures name, specifiers, and
 * operator. Specifier groups on the declaration's right-hand side (for example
 * `class<concrete>`) are intentionally excluded from the captured specifiers.
 */
const DECL_RE = /^(\w+)((?:<[^>]+>)*)\s*(:=|:|\()/;

/** The start of a parametric type head: an identifier, its specifier groups, and the `(` opening its type-parameter list. */
const PARAM_TYPE_HEAD_RE = /^(\w+)((?:<[^>]+>)*)\(/;

/** The `:=` and declaration keyword that must follow a parametric type's parameter list. */
const PARAM_TYPE_TAIL_RE = /^\s*:=\s*(module|class|struct|interface|enum)\b/;

/** Recognizes the declaration keyword after `:=` (module, class, struct, ...). */
const DECL_KEYWORD_RE = /^\s*(module|class|struct|interface|enum)\b/;

/** Extracts the explicit module import path from a `# Module import path:` comment. */
const MODULE_PATH_COMMENT_RE = /#\s*Module import path:\s*(\S+)/;

/**
 * A parametric type declared with a type-parameter list, such as
 * `subscribable<public>(t:type) := interface:` or
 * `agent_group<native><public>(member_info:subtype(member_info_interface)) := class(...):`,
 * or null where the line is not one.
 *
 * Must be tried before {@link DECL_RE}, whose `(` alternative would otherwise read
 * the type-parameter list as a function signature and leak the type's members to
 * module scope.
 *
 * The parameter list is walked for its matching `)` rather than matched by a
 * regex, because a Verse parenthesized parameter list holds general expressions
 * (`Paren := '(' List ')' Space`, VerseGrammar.h) and a parameter may itself be
 * an invocation carrying another paren group, to any depth. Any fixed depth here
 * would hold only until a digest refresh exceeded it.
 *
 * @param work The trimmed line with any scope qualifier prefix already removed.
 */
function matchParametricTypeHead(work: string): { name: string; specifiers: string; keyword: string } | null {
    const head = work.match(PARAM_TYPE_HEAD_RE);
    if (!head) {
        return null;
    }

    let depth = 0;
    let index = head[0].length - 1;
    for (; index < work.length; index++) {
        if (work[index] === "(") {
            depth++;
        } else if (work[index] === ")") {
            depth--;
            if (depth === 0) {
                index++;
                break;
            }
        }
    }
    if (depth !== 0) {
        return null;
    }

    const tail = work.slice(index).match(PARAM_TYPE_TAIL_RE);
    return tail ? { name: head[1], specifiers: head[2], keyword: tail[1] } : null;
}

/**
 * Maps a digest file name to the root module domain its top-level declarations
 * live under. Top-level modules without an explicit `# Module import path:`
 * comment (for example `Devices`, `Chat`) resolve relative to this domain.
 */
export function rootDomainForDigestFile(fileName: string): string {
    const base = fileName.toLowerCase();
    if (base.startsWith("fortnite")) {
        return "/Fortnite.com";
    }
    if (base.startsWith("unrealengine")) {
        return "/UnrealEngine.com";
    }
    if (base.startsWith("verse")) {
        return "/Verse.org";
    }
    return "";
}

/**
 * Resolves the import path of a module declaration by precedence: an explicit
 * `# Module import path:` comment, then a scope qualifier, then the enclosing
 * module, then the file's root domain.
 */
function resolveModulePath(name: string, pending: string | null, qualifierPath: string | null, stack: ModuleFrame[], rootDomain: string): string {
    if (pending !== null) {
        return pending;
    }
    if (qualifierPath) {
        return `${qualifierPath}/${name}`;
    }
    if (stack.length > 0) {
        return `${stack[stack.length - 1].path}/${name}`;
    }
    return `${rootDomain}/${name}`;
}

/**
 * Resolves the module a non-module declaration belongs to: its scope qualifier if
 * present, otherwise the enclosing module, otherwise the file's root domain.
 */
function containingModulePath(qualifierPath: string | null, stack: ModuleFrame[], rootDomain: string): string {
    if (qualifierPath) {
        return qualifierPath;
    }
    if (stack.length > 0) {
        return stack[stack.length - 1].path;
    }
    return rootDomain;
}

/**
 * Parses the raw text of a Verse API digest file into module-scoped entries.
 *
 * Only public, module-scope declarations are recorded; class/struct/interface/enum
 * members are skipped by indentation tracking. Entries deduplicate on first
 * occurrence, while the module index records every occurrence so a re-opened
 * module still contributes all of its members.
 *
 * @param content Raw text of a `*.digest.verse` file.
 * @param rootDomain Root module domain for the file, from {@link rootDomainForDigestFile}.
 */
export function parseDigestContent(content: string, rootDomain: string): ParsedDigest {
    const entries: Record<string, DigestEntry> = {};
    const moduleIndex = new Map<string, Set<string>>();

    const addEntry = (identifier: string, modulePath: string, type: DigestEntry["type"], isPublic: boolean): void => {
        if (!isPublic) {
            return;
        }
        let members = moduleIndex.get(modulePath);
        if (!members) {
            members = new Set<string>();
            moduleIndex.set(modulePath, members);
        }
        members.add(identifier);

        if (entries[identifier]) {
            return; // First occurrence wins.
        }
        entries[identifier] = { identifier, modulePath, type, isPublic };
    };

    // Explicit path from the most recent `# Module import path:` comment, applied
    // to the next module declaration only. Blank lines and other comments do not
    // clear it; only a module declaration consumes it.
    let pendingModulePath: string | null = null;
    const moduleStack: ModuleFrame[] = [];
    // Indents of open class/struct/interface/enum bodies, whose members are not
    // importable module-scope declarations.
    const classBodyIndents: number[] = [];

    // Records a `:=`-form module or type declaration and updates the scope stacks:
    // a module opens a new frame; a class/struct/interface/enum records itself and
    // opens a body whose members are skipped. Shared by the plain and parametric
    // (type-parameter-bearing) declaration paths.
    const recordModuleOrType = (name: string, isPublic: boolean, keyword: string, qualifierPath: string | null, indent: number): void => {
        if (keyword === "module") {
            const modulePath = resolveModulePath(name, pendingModulePath, qualifierPath, moduleStack, rootDomain);
            pendingModulePath = null;
            addEntry(name, modulePath, "module", isPublic);
            moduleStack.push({ path: modulePath, indent });
            return;
        }
        addEntry(name, containingModulePath(qualifierPath, moduleStack, rootDomain), "class", isPublic);
        classBodyIndents.push(indent);
    };

    for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();

        if (line === "") {
            continue;
        }
        if (line.startsWith("#")) {
            const commentMatch = line.match(MODULE_PATH_COMMENT_RE);
            if (commentMatch) {
                pendingModulePath = commentMatch[1];
            }
            continue;
        }
        // Attribute decorators and `using` imports never declare an importable name.
        if (line.startsWith("@") || line.startsWith("using")) {
            continue;
        }

        const indent = lineIndentWidth(rawLine);
        // Holds frames rather than bare indents, so it cannot use
        // popClosedBlocks; the closing rule has to stay in step with it.
        while (moduleStack.length > 0 && indent <= moduleStack[moduleStack.length - 1].indent) {
            moduleStack.pop();
        }
        popClosedBlocks(classBodyIndents, indent);

        // Anything still inside a class/struct/interface/enum body is a member.
        if (classBodyIndents.length > 0) {
            continue;
        }

        let qualifierPath: string | null = null;
        let work = line;
        const qualifierMatch = line.match(QUALIFIER_RE);
        if (qualifierMatch) {
            qualifierPath = qualifierMatch[1];
            work = line.slice(qualifierMatch[0].length);
        } else if (line.startsWith("(")) {
            // Receiver-style extension method or other parenthesized form: skip.
            continue;
        }

        // Before DECL_RE: the order is load-bearing, and matchParametricTypeHead says why.
        const paramType = matchParametricTypeHead(work);
        if (paramType) {
            recordModuleOrType(paramType.name, paramType.specifiers.includes("<public>"), paramType.keyword, qualifierPath, indent);
            continue;
        }

        const decl = work.match(DECL_RE);
        if (!decl) {
            continue;
        }
        const name = decl[1];
        const identifierSpecifiers = decl[2];
        const operator = decl[3];
        const isPublic = identifierSpecifiers.includes("<public>");

        if (operator === ":=") {
            const keywordMatch = work.slice(decl[0].length).match(DECL_KEYWORD_RE);
            const keyword = keywordMatch ? keywordMatch[1] : null;

            if (keyword) {
                // module or class / struct / interface / enum.
                recordModuleOrType(name, isPublic, keyword, qualifierPath, indent);
                continue;
            }

            addEntry(name, containingModulePath(qualifierPath, moduleStack, rootDomain), "variable", isPublic);
            continue;
        }

        const type: DigestEntry["type"] = operator === "(" ? "function" : "variable";
        addEntry(name, containingModulePath(qualifierPath, moduleStack, rootDomain), type, isPublic);
    }

    const moduleIndexRecord: Record<string, string[]> = {};
    for (const [modulePath, members] of moduleIndex) {
        moduleIndexRecord[modulePath] = [...members];
    }

    return { entries, moduleIndex: moduleIndexRecord };
}

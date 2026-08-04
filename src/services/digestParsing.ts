/**
 * Pure, VS Code-free parsing of Verse API digest files (`Fortnite.digest.verse`,
 * `Verse.digest.verse`, `UnrealEngine.digest.verse`) into a module-scoped
 * identifier index.
 *
 * This module is shared by the build-time precompiler
 * (`src/scripts/parseDigestFiles.ts`, run under ts-node) and the runtime fallback
 * parser (`DigestParser.parseDigestFile`). It must never import `vscode` so it can
 * run outside the extension host.
 *
 * The parser tracks indentation like `AssetsDigestParser.parseDigestContent`:
 * modules form a stack scoped by indent, and class/struct/interface/enum bodies
 * are tracked so their members are skipped (only module-scope declarations are
 * importable). Module import paths are resolved from, in precedence order, an
 * explicit `# Module import path:` comment, a scope qualifier `(/path:)`, the
 * enclosing module on the stack, or the file's root domain.
 */

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

/**
 * A parametric type head: an identifier, its specifier groups, a type-parameter
 * list, then `:=` and a declaration keyword, e.g.
 * `subscribable<public>(t:type) := interface:` or
 * `event<native><public>(t:type) := class(signalable(t)):`. Captures name,
 * specifiers, and keyword.
 *
 * This must be checked before {@link DECL_RE}, whose `(` alternative would
 * otherwise mistake the type-parameter list for a function signature and leak the
 * type's members. The parameter list is matched as `\([^)]*\)`: in the digests,
 * type-parameter lists never nest parentheses (nested parens only appear after
 * `:=`, in base-type lists).
 */
const PARAM_TYPE_DECL_RE = /^(\w+)((?:<[^>]+>)*)\([^)]*\)\s*:=\s*(module|class|struct|interface|enum)\b/;

/** Recognizes the declaration keyword after `:=` (module, class, struct, ...). */
const DECL_KEYWORD_RE = /^\s*(module|class|struct|interface|enum)\b/;

/** Extracts the explicit module import path from a `# Module import path:` comment. */
const MODULE_PATH_COMMENT_RE = /#\s*Module import path:\s*(\S+)/;

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
 * Returns the leading indentation width of a line, counting each tab as four
 * spaces so mixed indentation compares consistently.
 */
function indentOf(rawLine: string): number {
    const match = rawLine.match(/^[ \t]*/);
    return match ? match[0].replace(/\t/g, "    ").length : 0;
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

        const indent = indentOf(rawLine);
        while (moduleStack.length > 0 && indent <= moduleStack[moduleStack.length - 1].indent) {
            moduleStack.pop();
        }
        while (classBodyIndents.length > 0 && indent <= classBodyIndents[classBodyIndents.length - 1]) {
            classBodyIndents.pop();
        }

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

        // Parametric type heads (`name<...>(t:type) := interface:`) must be matched
        // before DECL_RE, whose `(` branch would misread the parameter list as a
        // function signature and leak the type's members.
        const paramType = work.match(PARAM_TYPE_DECL_RE);
        if (paramType) {
            const paramSpecifiers = paramType[2];
            recordModuleOrType(paramType[1], paramSpecifiers.includes("<public>"), paramType[3], qualifierPath, indent);
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

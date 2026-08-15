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
 * Declaration heads are recognized by `matchDeclarationHead`, shared with the
 * assets parser and the project scan; only the policy over its answer lives
 * here.
 *
 * Comments are skipped only where `#` is the line's first non-whitespace
 * character. Verse also has `<# #>` and `<#>` comments, and a `#` after code or
 * inside a string is not a comment at all, so this is a narrower rule than the
 * language's. It holds because the digests are machine-generated and carry only
 * whole-line `#` comments; a hand-written file would need the masking that
 * ProjectPathScanner does.
 */

import { DeclarationKeyword, matchDeclarationHead } from "../utils/verseDeclarationHead";
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
 * The result of parsing one digest file: every declaration of an identifier
 * keyed by that identifier, plus an index from module path to the identifiers
 * it exposes.
 *
 * An identifier maps to a list because one name is often public in several
 * modules at once - `Distance` is declared by both SpatialMath modules - and
 * each of those modules is a valid `using` target the user may need to choose
 * between. The list holds one declaration per module path, in declaration
 * order.
 */
export interface ParsedDigest {
    entries: Record<string, DigestEntry[]>;
    moduleIndex: Record<string, string[]>;
}

/**
 * Appends a declaration unless the identifier already has one from that module,
 * and reports whether it was appended.
 *
 * Shared by the two places that build an identifier's declaration list - the
 * parser within one file, the loader across files - because both rest on the
 * same invariant: one entry per module path, so a name is never offered as the
 * same import twice. Module-scope overloads make that a live case rather than a
 * defensive one, `ToString` being declared four times in its own module.
 *
 * @param declarations Mutated in place.
 */
export function appendDeclaration(declarations: DigestEntry[], declaration: DigestEntry): boolean {
    if (declarations.some((existing) => existing.modulePath === declaration.modulePath)) {
        return false;
    }
    declarations.push(declaration);
    return true;
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
 * members are skipped by indentation tracking. An identifier declared in several
 * modules keeps one entry per module, while the module index records every
 * occurrence so a re-opened module still contributes all of its members.
 *
 * @param content Raw text of a `*.digest.verse` file.
 * @param rootDomain Root module domain for the file, from {@link rootDomainForDigestFile}.
 */
export function parseDigestContent(content: string, rootDomain: string): ParsedDigest {
    const entries: Record<string, DigestEntry[]> = {};
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

        const declarations = entries[identifier] ?? (entries[identifier] = []);
        appendDeclaration(declarations, { identifier, modulePath, type, isPublic });
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
    const recordModuleOrType = (name: string, isPublic: boolean, keyword: DeclarationKeyword, qualifierPath: string | null, indent: number): void => {
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
        }

        const head = matchDeclarationHead(work);
        if (!head) {
            continue;
        }

        // A receiver-style extension method declares a name in this module, and
        // this index deliberately does not offer it: the project scan reads the
        // same head and does index one. Policy, not a difference of grammar -
        // see matchDeclarationHead's `receiver`.
        if (head.receiver !== null) {
            continue;
        }

        const isPublic = head.specifiers.includes("<public>");

        if (head.keyword) {
            recordModuleOrType(head.name, isPublic, head.keyword, qualifierPath, indent);
            continue;
        }

        // A parameter list makes it a function whichever operator follows, and
        // an unclosed one - a signature continuing below - reports as `(`.
        const type: DigestEntry["type"] = head.params !== null || head.operator === "(" ? "function" : "variable";
        addEntry(head.name, containingModulePath(qualifierPath, moduleStack, rootDomain), type, isPublic);
    }

    const moduleIndexRecord: Record<string, string[]> = {};
    for (const [modulePath, members] of moduleIndex) {
        moduleIndexRecord[modulePath] = [...members];
    }

    return { entries, moduleIndex: moduleIndexRecord };
}

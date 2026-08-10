/**
 * Turns a visibility plan plus the declarations a project already carries into
 * the concrete edits that make the target public. Pure - no VS Code
 * dependencies.
 */

import { DeclarationSpec } from "./definitionsContent";
import { ModuleDeclaration, SourceSpan } from "./moduleDeclarations";
import { VisibilitySegment } from "./ModuleVisibilityPlanner";

/** An explicit declaration found in the project, bound to the module it declares. */
export interface FoundDeclaration {
    /** Content-relative module path, slash-separated, e.g. "Gadgets/Tools". */
    path: string;

    /** Opaque file identifier, passed back on any edit against this declaration. */
    file: string;

    declaration: ModuleDeclaration;
}

/** One specifier rewrite. An empty span is an insertion at that offset. */
export interface SpecifierEdit {
    file: string;

    /** Content-relative path of the module being rewritten, for the report to the user. */
    path: string;

    span: SourceSpan;
    text: string;
}

/** Everything that has to happen for the target to become reachable. */
export interface ResolvedVisibility {
    /** Specifier rewrites against declarations that already exist. */
    edits: SpecifierEdit[];

    /**
     * The chain to write into the definitions file, outermost first, or empty
     * when every module that needed publicizing was already declared.
     */
    chain: DeclarationSpec[];

    /** Modules that could not be made public, with the specifier blocking each. */
    conflicts: { path: string; keyword: string }[];
}

const PUBLIC_SPECIFIER = "<public>";

/**
 * The edits and the declaration chain that make the planned segments reachable.
 *
 * Two rules keep this from producing `ErrSemantic_MismatchedPartialAttributes`.
 * A module's access level comes from its first explicit part, and every later
 * part must repeat the same specifier - so where a module is already declared,
 * EVERY part of it is rewritten rather than one, and where a chain is written
 * into the definitions file, each of its modules repeats whatever specifier the
 * project already declares for that module.
 *
 * A module already declared `<private>`, `<protected>` or `<scoped>` is
 * reported as a conflict instead of being rewritten: those are deliberate
 * narrowings, and widening one silently is a decision that belongs to whoever
 * wrote it. Nesting the chain THROUGH such a module conflicts too, even where
 * the module itself needs no marking - the part that would be written repeats
 * the specifier from a keyword alone, and a keyword alone is not the specifier
 * for `scoped`, which carries a module list.
 *
 * @param prefix Content-relative segments above the planned ones. They are
 * already reachable, but the chain is written at the Content root, so it has to
 * carry them or the declaration it nests would name a different module.
 */
export function resolveVisibility(prefix: readonly string[], segments: readonly VisibilitySegment[], found: readonly FoundDeclaration[]): ResolvedVisibility {
    const byPath = new Map<string, FoundDeclaration[]>();
    for (const entry of found) {
        const existing = byPath.get(entry.path);
        if (existing) {
            existing.push(entry);
        } else {
            byPath.set(entry.path, [entry]);
        }
    }

    const edits: SpecifierEdit[] = [];
    const chain: DeclarationSpec[] = [];
    const written: boolean[] = [];

    // Collected rather than reported on sight: whether nesting through a
    // narrowed module matters depends on the trim below, which is not known
    // until the walk is over.
    const blocked: { chainIndex: number; path: string; keyword: string; needsPublic: boolean }[] = [];

    // The prefix modules are reachable already, so they are walked purely as
    // the nesting the chain needs - never marked, but still matched against
    // what the project declares so a written part cannot disagree with one.
    const walk: VisibilitySegment[] = [...prefix.map((name) => ({ name, needsPublic: false })), ...segments];
    const pathSegments: string[] = [];

    for (const segment of walk) {
        pathSegments.push(segment.name);
        const modulePath = pathSegments.join("/");
        const declarations = byPath.get(modulePath) ?? [];

        if (declarations.length === 0) {
            chain.push({ name: segment.name, specifier: segment.needsPublic ? "public" : undefined });
            written.push(segment.needsPublic);
            continue;
        }

        const blocking = declarations.find((entry) => entry.declaration.visibility && entry.declaration.visibility.keyword !== "public" && entry.declaration.visibility.keyword !== "internal");

        if (blocking) {
            blocked.push({ chainIndex: chain.length, path: modulePath, keyword: blocking.declaration.visibility!.keyword, needsPublic: segment.needsPublic });
            // Written bare so the chain still nests, and never carrying the
            // blocking keyword: `<scoped>` without its module list does not
            // compile. Whether any of this is applied is decided below.
            chain.push({ name: segment.name });
            written.push(false);
            continue;
        }

        if (segment.needsPublic) {
            for (const entry of declarations) {
                const { visibility, insertionPoint } = entry.declaration;
                if (visibility?.keyword === "public") {
                    continue;
                }
                edits.push({
                    file: entry.file,
                    path: modulePath,
                    span: visibility ? { start: visibility.start, end: visibility.end } : { start: insertionPoint, end: insertionPoint },
                    text: PUBLIC_SPECIFIER,
                });
            }
        }

        // Repeat what the project already declares, so a part written below
        // this one cannot disagree with the parts that exist. Only `public` and
        // `internal` reach here - every other keyword left through the branch
        // above, which is what keeps a keyword-only repeat safe.
        const declaredKeyword = segment.needsPublic ? "public" : declarations[0].declaration.visibility?.keyword;
        chain.push({ name: segment.name, specifier: declaredKeyword });
        written.push(false);
    }

    // The chain exists only to carry declarations that are not there yet. With
    // none to carry, the nesting above them is noise.
    const deepestWritten = written.lastIndexOf(true);

    // A narrowed module blocks when it is the one to publicize, and equally
    // when the retained chain nests through it. Anything trimmed away is never
    // written, so a narrowing there is nobody's business.
    const conflicts = blocked.filter((entry) => entry.needsPublic || entry.chainIndex <= deepestWritten).map(({ path, keyword }) => ({ path, keyword }));

    return {
        edits,
        chain: deepestWritten === -1 ? [] : chain.slice(0, deepestWritten + 1),
        conflicts,
    };
}

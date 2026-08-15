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

/** A module whose existing declaration stops the request, and what about it stops it. */
export interface VisibilityConflict {
    /** Content-relative path of the module, for the report to the user. */
    path: string;

    /**
     * The declared visibility keyword alone, absent where no part of the module
     * carries a specifier. `scoped` carries a module list the scanner does not
     * capture, so this is not the specifier as written and must not be reported
     * as if it were.
     *
     * Only `repeat` reaches here without one: a keyword being present and
     * narrowed is what raises the other two.
     */
    keyword?: string;

    /**
     * `widen` where the module itself has to become public, `nest` where a new
     * part would be written inside it, `repeat` where the chain would restate a
     * declaration the project already carries. The remedies differ: the first
     * is a change to this module's specifier, the other two a declaration the
     * user must make by hand where the existing one lives.
     */
    reason: "widen" | "nest" | "repeat";
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

    /** Modules that could not be made public, with what blocks each. */
    conflicts: VisibilityConflict[];
}

const PUBLIC_SPECIFIER = "<public>";

/**
 * The edits and the declaration chain that make the planned segments reachable.
 *
 * A module's access level comes from its first explicit part, and every later
 * part must carry the same specifier or the compiler raises
 * `ErrSemantic_MismatchedPartialAttributes`. That is why a module the project
 * already declares has EVERY part of it rewritten rather than one.
 *
 * Three kinds of module are reported as conflicts rather than written. One
 * declared anything other than `<public>` or `<internal>` is a deliberate
 * narrowing, whether it is the module to publicize (`widen`) or one the chain
 * would nest a new part inside (`nest`); the second is mechanical as well,
 * since `scoped`'s module list resolves against the scope that declared it and
 * cannot be copied into a file at the Content root at all. One that already
 * carries an explicit declaration anywhere in the project is a `repeat`: the
 * chain restates it, and a restatement is a second explicit definition, which
 * is `ErrSemantic_AmbiguousDefinition` in a user package unless that package
 * sets `treatModulesAsImplicit`. The specifier is not what makes it one - a
 * bare part counts the same - so every declared module the retained chain
 * carries is reported, and only a module with no declaration at all is safe to
 * write.
 *
 * Refusing is the caller's job, and a conflict leaves the chain as it is rather
 * than emptying it. Nothing reads the chain on that path today, so the fact
 * worth knowing before editing either half is the invariant rather than the
 * consumer: the trim and the `repeat` test are the same predicate, so a chain
 * entry whose specifier was copied off an existing declaration always coincides
 * with a conflict, and that specifier never reaches a file.
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

    // Every module the walk found a declaration for, collected for the same
    // reason as `blocked`: whether the chain actually restates one depends on
    // the trim below.
    const declared: { chainIndex: number; path: string; keyword?: string }[] = [];

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
            // Bare so the chain still nests, and never carrying the blocking
            // keyword: `<scoped>` without its module list does not compile.
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

        // What the files say now, not what the edits above would make them say:
        // this is reported to the user, who has to go and find the declaration.
        // Parts that disagree are already `ErrSemantic_MismatchedPartialAttributes`,
        // so preferring the one carrying a specifier changes the answer only on
        // a project that does not compile - where it buys a report that does not
        // vary with scan order.
        const reportedDeclaration = declarations.find((entry) => entry.declaration.visibility) ?? declarations[0];
        declared.push({ chainIndex: chain.length, path: modulePath, keyword: reportedDeclaration.declaration.visibility?.keyword });

        // The specifier a part here would have had to carry, which is never
        // written: a declared module in the retained chain is always a repeat.
        const declaredKeyword = segment.needsPublic ? "public" : reportedDeclaration.declaration.visibility?.keyword;
        chain.push({ name: segment.name, specifier: declaredKeyword });
        written.push(false);
    }

    // The chain exists only to carry declarations that are not there yet. With
    // none to carry, the nesting above them is noise.
    const deepestWritten = written.lastIndexOf(true);

    // A narrowed module blocks when it is the one to publicize, and equally
    // when the retained chain nests through it. Anything trimmed away is never
    // written, so a narrowing there is nobody's business.
    const conflicts: VisibilityConflict[] = blocked
        .filter((entry) => entry.needsPublic || entry.chainIndex <= deepestWritten)
        .map(({ path, keyword, needsPublic }) => ({ path, keyword, reason: needsPublic ? "widen" : "nest" }));

    // Same trim, for the same reason: a declaration is only restated where the
    // retained chain reaches it. A module publicized in place sits below the
    // deepest written part whenever nothing new goes under it, and is edited
    // rather than restated.
    for (const entry of declared) {
        if (entry.chainIndex <= deepestWritten) {
            conflicts.push({ path: entry.path, keyword: entry.keyword, reason: "repeat" });
        }
    }

    return {
        edits,
        chain: deepestWritten === -1 ? [] : chain.slice(0, deepestWritten + 1),
        conflicts,
    };
}

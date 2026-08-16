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
     * declaration the project carries somewhere the caller cannot extend. The
     * remedies differ: the first is a change to this module's specifier, the
     * other two a declaration the user must make by hand where the existing
     * one lives.
     */
    reason: "widen" | "nest" | "repeat";
}

/** Everything that has to happen for the target to become reachable. */
export interface ResolvedVisibility {
    /** Specifier rewrites against declarations that already exist. */
    edits: SpecifierEdit[];

    /**
     * The chain to write into the definitions file, outermost first, or empty
     * when every module that needed publicizing was already declared. With an
     * `anchor` it nests inside that declaration's body; without one it stands
     * alone at the Content root.
     */
    chain: DeclarationSpec[];

    /**
     * The definitions-file declaration the chain extends: the deepest module
     * on the target's path that file already declares. Absent when the chain
     * stands alone or there is nothing left to write.
     */
    anchor?: FoundDeclaration;

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
 * carries an explicit declaration is a `repeat`: the chain restates it, and a
 * restatement is a second explicit definition, which is
 * `ErrSemantic_AmbiguousDefinition` in a user package unless that package sets
 * `treatModulesAsImplicit`. The specifier is not what makes it one - a bare
 * part counts the same - so a declared module is safe only where nothing is
 * written for it.
 *
 * The definitions file is that exception. A declaration there is a block the
 * caller owns and can extend, so the deepest run of them from the root becomes
 * the `anchor`: nothing at or above it is restated, and the chain that remains
 * nests inside it. A declared module BELOW the anchor still repeats - its
 * declaration lives in a user file the chain cannot join.
 *
 * Refusing is the caller's job, and a conflict leaves the chain as it is rather
 * than emptying it. Nothing reads the chain on that path today, so the fact
 * worth knowing before editing either half is the invariant rather than the
 * consumer: the trim and the `repeat` test cover the same range, so a chain
 * entry whose specifier was copied off an existing declaration either falls to
 * the anchor's slice or coincides with a conflict, and that specifier never
 * reaches a file.
 *
 * @param prefix Content-relative segments above the planned ones. They are
 * already reachable, but the chain is written at the Content root, so it has to
 * carry them or the declaration it nests would name a different module.
 * @param definitionsFile opaque identifier of the definitions file the caller
 * owns, as `FoundDeclaration.file` spells it. Declarations there anchor the
 * chain instead of conflicting with it.
 */
export function resolveVisibility(prefix: readonly string[], segments: readonly VisibilitySegment[], found: readonly FoundDeclaration[], definitionsFile?: string): ResolvedVisibility {
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

    // The definitions-file declaration at each walk index, null where the
    // module is undeclared there, narrowed, or declared only elsewhere. The
    // anchor search below walks this.
    const definitionsDeclarations: (FoundDeclaration | null)[] = [];

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
            definitionsDeclarations.push(null);
            chain.push({ name: segment.name, specifier: segment.needsPublic ? "public" : undefined });
            written.push(segment.needsPublic);
            continue;
        }

        const blocking = declarations.find((entry) => entry.declaration.visibility && entry.declaration.visibility.keyword !== "public" && entry.declaration.visibility.keyword !== "internal");

        if (blocking) {
            // Null even when the narrowed declaration sits in the definitions
            // file: the narrowing is deliberate, so its block is not extended.
            definitionsDeclarations.push(null);
            blocked.push({ chainIndex: chain.length, path: modulePath, keyword: blocking.declaration.visibility!.keyword, needsPublic: segment.needsPublic });
            // Bare so the chain still nests, and never carrying the blocking
            // keyword: `<scoped>` without its module list does not compile.
            chain.push({ name: segment.name });
            written.push(false);
            continue;
        }

        // The last part in scan order, because a file declaring one module
        // twice does not compile and the writer's own appends come last: the
        // most recent block is the least surprising one to extend.
        const inDefinitions = declarations.filter((entry) => entry.file === definitionsFile);
        definitionsDeclarations.push(inDefinitions.length > 0 ? inDefinitions[inDefinitions.length - 1] : null);

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

    // The deepest module, contiguously from the root, whose declaration the
    // definitions file already carries. Contiguity is what makes the nest
    // sound: everything above the anchor is the existing block's own nesting,
    // so the chain can start directly inside it. It costs nothing real,
    // because a nested declaration's ancestors are declared in the same file.
    let anchorIndex = -1;
    while (anchorIndex + 1 < definitionsDeclarations.length && definitionsDeclarations[anchorIndex + 1] !== null) {
        anchorIndex++;
    }

    // A narrowed module blocks when it is the one to publicize, and equally
    // when the retained chain nests through it. Anything trimmed away is never
    // written, so a narrowing there is nobody's business.
    const conflicts: VisibilityConflict[] = blocked
        .filter((entry) => entry.needsPublic || entry.chainIndex <= deepestWritten)
        .map(({ path, keyword, needsPublic }) => ({ path, keyword, reason: needsPublic ? "widen" : "nest" }));

    // Same trim, for the same reason: a declaration is only restated where the
    // retained chain reaches it. A module publicized in place sits below the
    // deepest written part whenever nothing new goes under it, and is edited
    // rather than restated. At or above the anchor nothing is written either -
    // the existing block already carries those declarations.
    for (const entry of declared) {
        if (entry.chainIndex > anchorIndex && entry.chainIndex <= deepestWritten) {
            conflicts.push({ path: entry.path, keyword: entry.keyword, reason: "repeat" });
        }
    }

    const anchor = anchorIndex >= 0 && deepestWritten > anchorIndex ? definitionsDeclarations[anchorIndex]! : undefined;

    return {
        edits,
        chain: deepestWritten === -1 ? [] : chain.slice(anchorIndex + 1, deepestWritten + 1),
        ...(anchor ? { anchor } : {}),
        conflicts,
    };
}

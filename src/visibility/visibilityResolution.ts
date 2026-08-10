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

/** One specifier rewrite: replacing `span` when present, inserting at `offset` when not. */
export interface SpecifierEdit {
    file: string;
    span?: SourceSpan;
    offset: number;
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
 * Two rules keep this from producing `ErrSemantic_MismatchedPartialAttributes`,
 * which is what sank the 0.4.x attempt at this feature. A module's access level
 * comes from its first explicit part, and every later part must repeat the same
 * specifier - so where a module is already declared, EVERY part of it is
 * rewritten rather than one, and where a chain is written into the definitions
 * file, each of its modules repeats whatever specifier the project already
 * declares for that module.
 *
 * A module already declared `<private>`, `<protected>` or `<scoped>` is
 * reported as a conflict instead of being rewritten: those are deliberate
 * narrowings, and widening one silently is a decision that belongs to whoever
 * wrote it.
 *
 * @param prefix Content-relative segments above the planned ones, needed to
 * address a planned segment by its full path
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
    const conflicts: { path: string; keyword: string }[] = [];
    const chain: DeclarationSpec[] = [];
    const written: boolean[] = [];

    const pathSegments = [...prefix];

    for (const segment of segments) {
        pathSegments.push(segment.name);
        const modulePath = pathSegments.join("/");
        const declarations = byPath.get(modulePath) ?? [];

        if (declarations.length === 0) {
            chain.push({ name: segment.name, specifier: segment.needsPublic ? "public" : undefined });
            written.push(segment.needsPublic);
            continue;
        }

        const blocking = declarations.find((entry) => entry.declaration.visibility && entry.declaration.visibility.keyword !== "public" && entry.declaration.visibility.keyword !== "internal");

        if (segment.needsPublic && blocking) {
            conflicts.push({ path: modulePath, keyword: blocking.declaration.visibility!.keyword });
            // Written bare so the chain still nests, though the conflict means
            // the caller will not apply any of it.
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
                    span: visibility ? { start: visibility.start, end: visibility.end } : undefined,
                    offset: visibility ? visibility.start : insertionPoint,
                    text: PUBLIC_SPECIFIER,
                });
            }
        }

        // Repeat what the project already declares, so a part written below
        // this one cannot disagree with the parts that exist.
        const declaredKeyword = segment.needsPublic ? "public" : declarations[0].declaration.visibility?.keyword;
        chain.push({ name: segment.name, specifier: declaredKeyword });
        written.push(false);
    }

    // The chain exists only to carry declarations that are not there yet. With
    // none to carry, the nesting above them is noise.
    const deepestWritten = written.lastIndexOf(true);
    return {
        edits,
        chain: deepestWritten === -1 ? [] : chain.slice(0, deepestWritten + 1),
        conflicts,
    };
}

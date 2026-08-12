import { ProjectPathNode } from "../types";

/**
 * Pure lookup logic for resolving module import paths against scanned
 * project declarations. No VS Code dependencies, so it is unit-testable.
 *
 * Location contract (shared with ImportPathConverter's filesystem scan):
 * a location is the Content-relative parent directory of the module's
 * first path segment, formatted as "" for the Content root or "/Dir/Sub"
 * otherwise. The converter builds the final Verse path as
 * `${projectVersePath}${location}/${modulePath}`.
 */

/** The Content folder that anchors importable module locations. */
const CONTENT_FOLDER = "Content";

/**
 * A resolved module location plus the file that proves it, so callers can
 * validate against the filesystem before trusting a potentially stale cache.
 */
export interface ModuleLocationCandidate {
    /** Content-relative location prefix: "" or "/Dir/Sub" */
    location: string;

    /** Workspace-relative path of the .verse file declaring the module */
    sourceFile: string;
}

/** The lookup indexes derived from the flat node list. */
export interface ProjectIndexes {
    /** Lowercased identifier name -> all declarations with that name */
    identifierIndex: Map<string, ProjectPathNode[]>;

    /** Exact identifier name -> module declarations only */
    moduleNameIndex: Map<string, ProjectPathNode[]>;

    /** Workspace-relative source file -> declarations in that file */
    fileIndex: Map<string, ProjectPathNode[]>;
}

/**
 * Every lookup index, built from the node list in a single pass. Each index
 * holds references into that list rather than copies.
 */
export function buildProjectIndexes(nodes: readonly ProjectPathNode[]): ProjectIndexes {
    const identifierIndex = new Map<string, ProjectPathNode[]>();
    const moduleNameIndex = new Map<string, ProjectPathNode[]>();
    const fileIndex = new Map<string, ProjectPathNode[]>();

    for (const node of nodes) {
        const identifierKey = node.name.toLowerCase();
        const byIdentifier = identifierIndex.get(identifierKey);
        if (byIdentifier) {
            byIdentifier.push(node);
        } else {
            identifierIndex.set(identifierKey, [node]);
        }

        if (node.type === "module") {
            const byModuleName = moduleNameIndex.get(node.name);
            if (byModuleName) {
                byModuleName.push(node);
            } else {
                moduleNameIndex.set(node.name, [node]);
            }
        }

        if (node.sourceFile) {
            const byFile = fileIndex.get(node.sourceFile);
            if (byFile) {
                byFile.push(node);
            } else {
                fileIndex.set(node.sourceFile, [node]);
            }
        }
    }

    return { identifierIndex, moduleNameIndex, fileIndex };
}

/**
 * The distinct locations a module import path could refer to, one entry per
 * location with the first source file found for it.
 *
 * The requested path uses "/" separators as produced by
 * ImportPathConverter.extractModuleFromImport (e.g. "HUD/Textures" for the
 * relative import `using { HUD.Textures }`). Matching is case-sensitive and
 * on whole segments: the node's in-file module chain must match the tail of
 * the requested segments, and any remaining leading segments must match the
 * tail of the file's Content-relative directory (folders are implicit
 * modules). Non-module declarations are never considered.
 *
 * @param workspaceIsContent whether the workspace folder itself is the
 * Content folder (source file paths then have no "Content/" prefix).
 */
export function resolveModuleLocations(modulePath: string, moduleNameIndex: ReadonlyMap<string, ProjectPathNode[]>, options: { workspaceIsContent: boolean }): ModuleLocationCandidate[] {
    const requested = modulePath
        .replace(/^\//, "")
        .split("/")
        .filter((s) => s.length > 0);
    if (requested.length === 0) {
        return [];
    }

    const moduleName = requested[requested.length - 1];
    const candidates = moduleNameIndex.get(moduleName) || [];
    const results: ModuleLocationCandidate[] = [];
    const seenLocations = new Set<string>();

    for (const node of candidates) {
        if (!node.sourceFile) {
            continue;
        }

        const chain = node.fullPath.split(".").filter((s) => s.length > 0);
        if (chain.length === 0 || chain.length > requested.length) {
            continue;
        }

        // The declaration's in-file module chain must equal the tail of the
        // requested segments, whole segment by whole segment.
        let chainMatches = true;
        for (let i = 0; i < chain.length; i++) {
            if (requested[requested.length - chain.length + i] !== chain[i]) {
                chainMatches = false;
                break;
            }
        }
        if (!chainMatches) {
            continue;
        }

        const contentRelativeDir = toContentRelativeDir(node.sourceFile, options.workspaceIsContent);
        if (contentRelativeDir === null) {
            continue;
        }

        const dirSegments = contentRelativeDir.split("/").filter((s) => s.length > 0);

        // Any requested segments not covered by the in-file chain must be
        // implicit folder modules: they must match the tail of the file's
        // Content-relative directory.
        const remaining = requested.slice(0, requested.length - chain.length);
        if (remaining.length > dirSegments.length) {
            continue;
        }
        let dirMatches = true;
        for (let i = 0; i < remaining.length; i++) {
            if (dirSegments[dirSegments.length - remaining.length + i] !== remaining[i]) {
                dirMatches = false;
                break;
            }
        }
        if (!dirMatches) {
            continue;
        }

        const locationSegments = dirSegments.slice(0, dirSegments.length - remaining.length);
        const location = locationSegments.length > 0 ? "/" + locationSegments.join("/") : "";

        if (!seenLocations.has(location)) {
            seenLocations.add(location);
            results.push({ location, sourceFile: node.sourceFile });
        }
    }

    return results;
}

/**
 * The locations a module import path could refer to as a chain of folders,
 * given every Content-relative directory the project holds `.verse` files in.
 *
 * Folders are implicit modules, so a directory attests to a module chain with
 * no declaration anywhere to read. Each input directory therefore stands for
 * itself and for every ancestor of it: only `Systems/Combat/Weapons` need hold
 * a `.verse` file for `Systems` and `Systems/Combat` to be modules too.
 *
 * Matching is case-sensitive and on whole segments, so `Systems/XCombat/Weapons`
 * does not answer a request for `Combat/Weapons`. Results are sorted, because
 * they are put to the user as an ordered list of paths to choose between and
 * the directory enumeration behind them has no guaranteed order.
 *
 * @param modulePath separated by "/", as extractModuleFromImport produces
 * @param contentRelativeDirs directories relative to the Content root, "" for the root itself
 * @returns distinct locations under the contract at the top of this file: "" or "/Dir/Sub"
 */
export function resolveFolderModuleLocations(modulePath: string, contentRelativeDirs: Iterable<string>): string[] {
    const requested = modulePath
        .replace(/^\//, "")
        .split("/")
        .filter((s) => s.length > 0);
    if (requested.length === 0) {
        return [];
    }

    const locations = new Set<string>();

    for (const dir of contentRelativeDirs) {
        const segments = dir.split("/").filter((s) => s.length > 0);

        // Every ancestor of the directory, the directory itself included, is a
        // module chain the request could name the tail of.
        for (let depth = segments.length; depth >= requested.length; depth--) {
            let matches = true;
            for (let i = 0; i < requested.length; i++) {
                if (segments[depth - requested.length + i] !== requested[i]) {
                    matches = false;
                    break;
                }
            }
            if (!matches) {
                continue;
            }

            const locationSegments = segments.slice(0, depth - requested.length);
            locations.add(locationSegments.length > 0 ? "/" + locationSegments.join("/") : "");
        }
    }

    return Array.from(locations).sort();
}

/**
 * The Content-relative directory of a workspace-relative source file, or null
 * when the file sits outside the Content folder and so cannot provide an
 * importable module location.
 *
 * Exported so the converter's filesystem scan maps paths through this rather
 * than through a second copy of the rule: the two must agree on where Content
 * starts, or the same project resolves differently depending on which of them
 * asked.
 *
 * @param sourceFile workspace-relative, separated by "/"
 */
export function toContentRelativeDir(sourceFile: string, workspaceIsContent: boolean): string | null {
    const lastSlash = sourceFile.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : sourceFile.slice(0, lastSlash);

    if (workspaceIsContent) {
        return dir === "." ? "" : dir;
    }

    if (dir === CONTENT_FOLDER) {
        return "";
    }
    if (dir.startsWith(`${CONTENT_FOLDER}/`)) {
        return dir.slice(CONTENT_FOLDER.length + 1);
    }
    return null;
}

/**
 * Version of the persisted cache format. Bumping this invalidates previously
 * stored caches (they are rebuilt on next activation). Shared by the scanner
 * that stamps payloads and the cache that validates them.
 */
export const PROJECT_CACHE_VERSION = "2";

/**
 * A single declaration found in a .verse file.
 */
export interface ProjectPathNode {
    name: string;

    /**
     * Dot-chain of enclosing explicit module declarations within the source
     * file, ending in this declaration's name (e.g. "Outer.Inner" for a
     * module Inner declared inside module Outer, or just "Inner" for a
     * top-level declaration). This reflects nesting inside the file only;
     * folder structure is not part of it.
     */
    fullPath: string;

    type: "module" | "class" | "struct" | "function" | "variable" | "interface" | "enum";

    isPublic: boolean;

    /** Relative to the workspace folder, and without the folder's own name. */
    sourceFile?: string;

    /** One-based line the declaration starts on, as an editor would show it. */
    sourceLine?: number;
}

/**
 * The scanned project declaration data held by the cache.
 * All lookup indexes are derived from `nodes` and are not persisted.
 */
export interface ProjectPathData {
    projectVersePath: string;

    projectName: string;

    /**
     * Milliseconds since the epoch, stamped by a full scan and by invalidation.
     * Deleting a file prunes `nodes` without restamping, so this is the age of
     * the last scan and not a last-modified time.
     */
    generatedAt: number;

    /** Every declaration in the project, flat: nesting lives in `fullPath`. */
    nodes: ProjectPathNode[];
}

/**
 * Persisted shape of the cache in VS Code workspace storage.
 */
export interface SerializedProjectPathCache extends ProjectPathData {
    /** Format version; payloads with a different version are discarded */
    version: string;
}

/**
 * Options for scanning the project for declarations.
 */
export interface ProjectScanOptions {
    /**
     * Globs relative to the workspace folder. Only the first is read; the
     * scanner passes one include pattern to `findFiles` and drops the rest.
     */
    includePatterns?: string[];

    /** Globs; a match here is skipped even when the include pattern took it. */
    excludePatterns?: string[];

    /**
     * Off by default, dropping private declarations. Modules are held to more
     * than that: one is kept only when it is public or internal.
     */
    includePrivate?: boolean;

    /** Called per file scanned, with `file` relative to the workspace folder. */
    onProgress?: (current: number, total: number, file: string) => void;
}

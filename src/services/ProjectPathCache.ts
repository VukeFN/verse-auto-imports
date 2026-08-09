import * as vscode from "vscode";
import * as path from "path";
import { logger } from "../utils";
import { ProjectPathHandler } from "../project";
import { ProjectPathScanner } from "./ProjectPathScanner";
import { PROJECT_CACHE_VERSION, ProjectPathData, ProjectPathNode, SerializedProjectPathCache } from "../types";
import { buildProjectIndexes, resolveModuleLocations, ModuleLocationCandidate, ProjectIndexes } from "./moduleLocationLookup";

/**
 * Caches the project's scanned declarations in VS Code workspace storage and
 * serves module-location lookups from derived in-memory indexes. Data is a
 * flat node list; all indexes are rebuilt from it on load and after updates.
 */
export class ProjectPathCache {
    private data: ProjectPathData | null = null;
    private indexes: ProjectIndexes = buildProjectIndexes([]);
    private fileWatcher: vscode.FileSystemWatcher | null = null;
    private pendingUpdates: Set<string> = new Set();
    private updateDebounceTimer: NodeJS.Timeout | null = null;
    private initialized: boolean = false;

    private static readonly CACHE_KEY = "projectPathTree";
    /** Storage key of the pre-2 metadata payload; cleared on save. */
    private static readonly LEGACY_METADATA_KEY = "projectPathTreeMeta";
    /**
     * Fallbacks for the two settings this class reads. Each must equal the
     * default package.json registers for the same key: config.get returns the
     * registered default for a registered setting, so a fallback that disagrees
     * is dead in production and live only under the test mock.
     */
    private static readonly DEBOUNCE_MS = 500;
    private static readonly AUTO_REBUILD_ON_STARTUP = false;

    constructor(
        private context: vscode.ExtensionContext,
        private outputChannel: vscode.OutputChannel,
        private projectPathHandler: ProjectPathHandler,
    ) {}

    /**
     * The watcher debounce delay, in milliseconds. Read where the timer is
     * armed rather than at construction, so changing the setting applies to the
     * next file change instead of waiting for a window reload.
     */
    private getDebounceMs(): number {
        return vscode.workspace.getConfiguration("verseAutoImports").get<number>("cache.watcherDebounceMs", ProjectPathCache.DEBOUNCE_MS);
    }

    /**
     * Brings the cache up, from workspace storage where possible and from a
     * fresh scan otherwise. Safe to call more than once; only a call that ends
     * with data latches.
     *
     * cache.autoRebuildOnStartup skips the stored payload entirely and scans
     * the project instead. The stored cache is only as fresh as the watchers
     * that maintained it, so a project edited outside this window - a UEFN
     * build, a branch switch - starts stale; rebuilding trades startup time for
     * that certainty.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        const startTime = Date.now();
        logger.info("ProjectPathCache", "Initializing project path cache...");

        try {
            const autoRebuild = vscode.workspace.getConfiguration("verseAutoImports").get<boolean>("cache.autoRebuildOnStartup", ProjectPathCache.AUTO_REBUILD_ON_STARTUP);

            if (autoRebuild) {
                logger.info("ProjectPathCache", "cache.autoRebuildOnStartup is on, rebuilding instead of loading the stored cache...");
                await this.rebuildCache();

                // A rebuild that found no UEFN project leaves the cache empty.
                // Preferring a fresh scan must not be worse than not asking for
                // one, so fall back to whatever storage holds: stale
                // declarations still serve lookups the empty cache would miss.
                if (!this.data && (await this.loadFromStorage())) {
                    logger.info("ProjectPathCache", "Rebuild found no project; kept the stored cache rather than starting empty");
                }
            } else {
                const loaded = await this.loadFromStorage();

                if (loaded) {
                    logger.info("ProjectPathCache", `Loaded cache from storage in ${Date.now() - startTime}ms`);
                } else {
                    logger.info("ProjectPathCache", "No valid cache found, building fresh...");
                    await this.rebuildCache();
                }
            }

            // Latch only once the cache actually holds data. A build that found
            // no UEFN project - the workspace was opened before the
            // .uefnproject existed, or it sits above the scanner's search depth
            // - leaves the cache empty, and latching there would make every
            // later lookup miss for the rest of the session.
            this.initialized = this.data !== null;
        } catch (error) {
            logger.error("ProjectPathCache", "Failed to initialize cache", error);
        }
    }

    /**
     * The possible locations of a module import path, empty when nothing is
     * cached.
     *
     * Candidates use the same location contract the converter's
     * filesystem scan produces ("" or "/Dir/Sub", Content-relative), each
     * with the source file that declares the module so callers can validate
     * against the filesystem before trusting the (possibly stale) cache.
     * Only explicit module declarations are known to the cache; implicit
     * folder modules are the filesystem scan's job.
     */
    lookupModuleLocations(modulePath: string): ModuleLocationCandidate[] {
        if (!this.data) {
            return [];
        }

        return resolveModuleLocations(modulePath, this.indexes.moduleNameIndex, {
            workspaceIsContent: this.workspaceIsContent(),
        });
    }

    /**
     * Rescans the whole project and replaces the cache with the result.
     *
     * A scan that finds no project leaves the existing cache untouched rather
     * than emptying it, so a rebuild can never be worse than not rebuilding.
     */
    async rebuildCache(): Promise<void> {
        const startTime = Date.now();
        logger.info("ProjectPathCache", "Rebuilding project path cache...");

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                logger.warn("ProjectPathCache", "No workspace folders found");
                return;
            }

            const scanner = new ProjectPathScanner(this.outputChannel, this.projectPathHandler);
            const data = await scanner.scanProject(workspaceFolders[0]);

            if (data) {
                this.data = data;
                this.initialized = true;
                this.rebuildIndexes();
                await this.saveToStorage();

                logger.info("ProjectPathCache", `Cache rebuilt: ${this.data.nodes.length} declarations in ${Date.now() - startTime}ms`);
            }
        } catch (error) {
            logger.error("ProjectPathCache", "Failed to rebuild cache", error);
        }
    }

    /**
     * Reparses the named files and swaps their declarations into the cache.
     *
     * A file that could not be read keeps the declarations it already had,
     * rather than committing as one that declares nothing; the next change
     * event reparses it. A file that was read and declares nothing does commit
     * as empty, which is what makes deleting the last declaration in a file
     * take effect.
     *
     * Parsing awaits, and `this.data` can be replaced while it does - the
     * .uefnproject watcher, watcher teardown and the Clear Project Path Cache
     * command all reach {@link clear}. The commit below therefore runs against
     * the snapshot taken here and is abandoned if the field has moved on, so
     * the update can neither dereference a cleared cache nor write nodes into
     * one a rebuild has already repopulated.
     */
    async invalidateFiles(filePaths: string[]): Promise<void> {
        const data = this.data;
        if (!data) {
            return;
        }

        logger.debug("ProjectPathCache", `Invalidating ${filePaths.length} files`);

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        const scanner = new ProjectPathScanner(this.outputChannel, this.projectPathHandler);

        const parsedResults: Map<string, ProjectPathNode[]> = new Map();
        const failedFiles: string[] = [];

        for (const filePath of filePaths) {
            try {
                const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
                const nodes = await scanner.parseVerseFile(fileUri, workspaceFolders[0]);

                // Staying out of parsedResults is what keeps this file's
                // existing nodes: the commit below only replaces files it
                // reparsed. The scanner logged the failure already.
                if (nodes === null) {
                    failedFiles.push(filePath);
                    continue;
                }

                parsedResults.set(filePath, nodes);
            } catch (error) {
                logger.error("ProjectPathCache", `Failed to reparse ${filePath}`, error);
                failedFiles.push(filePath);
            }
        }

        // The cache was cleared or rebuilt while parsing; the snapshot these
        // nodes were computed against is gone, so there is nothing to commit to.
        if (this.data !== data) {
            logger.debug("ProjectPathCache", "Cache changed during invalidation, discarding the parsed update");
            return;
        }

        const reparsedFiles = new Set(parsedResults.keys());
        const keptNodes = data.nodes.filter((node) => !node.sourceFile || !reparsedFiles.has(node.sourceFile));
        for (const newNodes of parsedResults.values()) {
            keptNodes.push(...newNodes);
        }
        data.nodes = keptNodes;
        this.rebuildIndexes();

        if (failedFiles.length > 0) {
            logger.warn("ProjectPathCache", `Reparse failed for ${failedFiles.length} file(s), left as cached: ${failedFiles.join(", ")}`);
        }

        data.generatedAt = Date.now();
        await this.saveToStorage();
    }

    /**
     * Starts watching the project and returns the handle that stops it.
     * Disposing also clears the in-memory cache, which is what cancels a
     * debounced update that would otherwise run after deactivation.
     */
    setupFileWatchers(): vscode.Disposable {
        const disposables: vscode.Disposable[] = [];

        this.fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.verse");

        this.fileWatcher.onDidChange((uri) => this.handleFileChange(uri));
        this.fileWatcher.onDidCreate((uri) => this.handleFileChange(uri));
        this.fileWatcher.onDidDelete((uri) => this.handleFileDelete(uri));

        disposables.push(this.fileWatcher);

        // Watch for .uefnproject changes to trigger full cache rebuild.
        // Creation counts as much as change: a workspace opened before the
        // project file exists builds nothing, and the file appearing is the
        // signal that a rebuild can finally succeed.
        const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.uefnproject");
        const rebuildOnProjectFile = () => {
            logger.debug("ProjectPathCache", "Project file changed, triggering cache rebuild");
            this.clear();
            this.rebuildCache().catch((error) => {
                logger.error("ProjectPathCache", "Failed to rebuild cache after project change", error);
            });
        };
        projectWatcher.onDidChange(rebuildOnProjectFile);
        projectWatcher.onDidCreate(rebuildOnProjectFile);
        disposables.push(projectWatcher);

        // Clear any pending debounced update on teardown so it cannot run
        // against a disposed extension context after deactivation.
        disposables.push({ dispose: () => this.clear() });

        logger.debug("ProjectPathCache", "File watchers set up");

        return vscode.Disposable.from(...disposables);
    }

    getStats(): {
        loaded: boolean;
        identifiers: number;
        files: number;
        generatedAt: number | null;
    } {
        return {
            loaded: this.data !== null,
            identifiers: this.indexes.identifierIndex.size,
            files: this.indexes.fileIndex.size,
            generatedAt: this.data?.generatedAt || null,
        };
    }

    /**
     * Drops the in-memory cache and any queued update, leaving the persisted
     * copy alone. Doubles as the watcher-teardown hook, so it must stay safe to
     * call when nothing was ever loaded.
     */
    clear(): void {
        this.data = null;
        // Keeps `initialized` meaning "the cache holds data", so a later
        // initialize() rebuilds instead of returning early onto nothing.
        this.initialized = false;
        this.indexes = buildProjectIndexes([]);
        this.pendingUpdates.clear();

        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
            this.updateDebounceTimer = null;
        }

        logger.debug("ProjectPathCache", "Cache cleared");
    }

    /**
     * Clear the in-memory cache and remove the persisted copy from workspace
     * storage. Unlike {@link clear}, which only wipes in-memory state and is
     * reused as the watcher-teardown hook, this also drops the stored payload
     * so the next session starts cold. Use it to recover from a corrupt cache
     * or to test cold-start behavior; it does not trigger a rebuild.
     */
    async clearAll(): Promise<void> {
        this.clear();

        await ProjectPathCache.clearPersistedCache(this.context);

        logger.info("ProjectPathCache", "Persisted cache cleared from workspace storage");
    }

    /**
     * Drop the persisted copy without needing a cache instance. Activation uses
     * this when the feature is switched off: nothing then loads or invalidates
     * what an earlier session stored, and the cache commands are guarded off
     * too, so a payload left behind can never be read or removed again.
     *
     * Returns whether there was one to drop, so a caller can say so; every
     * later startup with the feature off then finds nothing and writes nothing.
     */
    static async clearPersistedCache(context: vscode.ExtensionContext): Promise<boolean> {
        const stored = context.workspaceState.get(ProjectPathCache.CACHE_KEY) !== undefined || context.workspaceState.get(ProjectPathCache.LEGACY_METADATA_KEY) !== undefined;
        if (!stored) {
            return false;
        }

        await context.workspaceState.update(ProjectPathCache.CACHE_KEY, undefined);
        await context.workspaceState.update(ProjectPathCache.LEGACY_METADATA_KEY, undefined);
        return true;
    }

    /**
     * Writes the cache to workspace storage, stamped with the current
     * PROJECT_CACHE_VERSION, and drops the legacy payload on the way past.
     */
    private async saveToStorage(): Promise<void> {
        if (!this.data) {
            return;
        }

        try {
            const serialized: SerializedProjectPathCache = {
                version: PROJECT_CACHE_VERSION,
                projectVersePath: this.data.projectVersePath,
                projectName: this.data.projectName,
                generatedAt: this.data.generatedAt,
                nodes: this.data.nodes,
            };

            await this.context.workspaceState.update(ProjectPathCache.CACHE_KEY, serialized);
            await this.context.workspaceState.update(ProjectPathCache.LEGACY_METADATA_KEY, undefined);

            logger.debug("ProjectPathCache", "Cache saved to workspace storage");
        } catch (error) {
            logger.error("ProjectPathCache", "Failed to save cache", error);
        }
    }

    /**
     * Whether a usable cache was restored from workspace storage. A stored
     * payload is rejected when its version does not match the current one or
     * when it belongs to a different project, since either makes its
     * declarations wrong rather than merely stale.
     */
    private async loadFromStorage(): Promise<boolean> {
        try {
            const serialized = this.context.workspaceState.get<SerializedProjectPathCache>(ProjectPathCache.CACHE_KEY);

            if (!serialized) {
                return false;
            }

            // The nodes check also rejects the pre-2 tree-shaped payload, whose
            // version field a future bump could otherwise let through.
            if (serialized.version !== PROJECT_CACHE_VERSION || !Array.isArray(serialized.nodes)) {
                logger.info("ProjectPathCache", "Cache version mismatch, will rebuild");
                return false;
            }

            const currentProjectName = await this.projectPathHandler.getProjectName();
            if (currentProjectName && serialized.projectName !== currentProjectName) {
                logger.info("ProjectPathCache", "Project name mismatch, will rebuild");
                return false;
            }

            this.data = {
                projectVersePath: serialized.projectVersePath,
                projectName: serialized.projectName,
                generatedAt: serialized.generatedAt,
                nodes: serialized.nodes,
            };

            this.rebuildIndexes();

            logger.debug("ProjectPathCache", `Loaded ${this.data.nodes.length} declarations from storage`);

            return true;
        } catch (error) {
            logger.error("ProjectPathCache", "Failed to load cache from storage", error);
            return false;
        }
    }

    /** Must follow every mutation of `data.nodes`, or lookups serve the old set. */
    private rebuildIndexes(): void {
        this.indexes = buildProjectIndexes(this.data ? this.data.nodes : []);
    }

    /**
     * Whether the workspace folder itself is the Content folder (affects how
     * source file paths map to Content-relative locations).
     */
    private workspaceIsContent(): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }
        return path.basename(workspaceFolders[0].uri.fsPath) === "Content";
    }

    /**
     * Whether a URI points at a generated *.digest.verse file. Digest files are
     * generated API surface, never project declarations, so they must never
     * enter this cache regardless of which workspace root they live in. In the
     * UEFN multi-root workspace the external Assets.digest.verse is reachable by
     * the workspace-wide .verse watcher; without this guard its regeneration is
     * re-rooted into the project Content folder, where the scanner then errors
     * on a nonexistent path.
     */
    static isDigestFile(uri: { fsPath: string }): boolean {
        return uri.fsPath.toLowerCase().endsWith(".digest.verse");
    }

    /** Queues a changed file for reparsing once the debounce window closes. */
    private handleFileChange(uri: vscode.Uri): void {
        if (ProjectPathCache.isDigestFile(uri)) {
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(uri, false);
        this.pendingUpdates.add(relativePath);

        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
        }

        // Nothing awaits the timer callback, so a rejection escaping it would be
        // an unhandled rejection in the extension host rather than a logged fault.
        this.updateDebounceTimer = setTimeout(() => {
            const filesToUpdate = Array.from(this.pendingUpdates);
            this.pendingUpdates.clear();

            logger.debug("ProjectPathCache", `Processing ${filesToUpdate.length} file changes`);
            this.invalidateFiles(filesToUpdate).catch((error) => {
                logger.error("ProjectPathCache", "Failed to invalidate changed files", error);
            });
        }, this.getDebounceMs());
    }

    /**
     * Drops a deleted file's declarations immediately, without the debounce a
     * change gets - there is nothing left to reparse and nothing to coalesce.
     */
    private handleFileDelete(uri: vscode.Uri): void {
        if (ProjectPathCache.isDigestFile(uri)) {
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(uri, false);

        if (!this.data) {
            return;
        }

        this.data.nodes = this.data.nodes.filter((node) => node.sourceFile !== relativePath);
        this.rebuildIndexes();

        this.saveToStorage().catch((error) => {
            logger.error("ProjectPathCache", "Failed to save after file delete", error);
        });

        logger.debug("ProjectPathCache", `Removed ${relativePath} from cache`);
    }
}

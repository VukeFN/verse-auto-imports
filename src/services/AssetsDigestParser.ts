import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { logger } from "../utils";
import { ProjectPathHandler } from "../project";

/**
 * Matches a class or struct declaration in Assets.digest.verse, e.g.
 * `TestMaterial<scoped {...}> := class<final><scoped {...}>(mesh_component):`.
 * Specifiers may be absent, single, or stacked, and may carry `{...}` arguments,
 * on both the declared name and the `class`/`struct` keyword. Captures the type
 * name. Any specifier keyword is accepted (`public`, `protected`, `private`,
 * `internal`, `scoped`, `final`, ...), matching how ProjectPathScanner reads the
 * same grammar rather than the pre-41.10 `public|internal|private` allowlist.
 */
const CLASS_OR_STRUCT_DECL = /^(\w+)(?:<[^>]*>)*\s*:=\s*(?:class|struct)\b/;

/**
 * Matches an asset instance declaration at module scope, e.g.
 * `image1<scoped {...}>:texture = external {}`. Textures, meshes, and niagara
 * systems are emitted as instances rather than classes in 41.10. Captures the
 * instance name. The `external` anchor keeps ordinary constant assignments out.
 */
const INSTANCE_DECL = /^(\w+)(?:<[^>]*>)*\s*:\s*\w+\s*=\s*external\b/;

/**
 * Parses the project's Assets.digest.verse file to extract class names.
 * This is used to determine the correct module boundary when inferring imports
 * from "Did you mean X.Y.Z.ClassName" error messages.
 */
export class AssetsDigestParser {
    private classNames: Set<string> = new Set();
    private lastParsed: number = 0;
    private fileWatcher: vscode.FileSystemWatcher | null = null;
    private cachedDigestPath: string | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes (aligned with DigestParser)
    /**
     * How long to wait after the last watcher event before re-parsing. UEFN
     * rewrites the digest in bursts, so waiting coalesces a burst into one
     * parse. It also leaves room for ProjectPathHandler, which clears its
     * project name cache from a separate watcher on the same `.uefnproject`
     * event: both handlers run in the same event-loop turn, so the wait is far
     * longer than the gap between them, though nothing contracts that order.
     */
    private static readonly REFRESH_DEBOUNCE_MS = 250;

    constructor(
        private outputChannel: vscode.OutputChannel,
        private projectPathHandler: ProjectPathHandler,
    ) {}

    /**
     * Gets the path to the project's Assets.digest.verse file.
     * Location: {LOCALAPPDATA}\UnrealEditorFortnite\Saved\VerseProject\{ProjectName}\{ProjectName}-Assets\Assets.digest.verse
     */
    async getAssetsDigestPath(): Promise<string | null> {
        if (this.cachedDigestPath && fs.existsSync(this.cachedDigestPath)) {
            return this.cachedDigestPath;
        }

        const projectName = await this.projectPathHandler.getProjectName();
        if (!projectName) {
            logger.debug("AssetsDigestParser", "Project name not found, cannot locate Assets.digest.verse");
            return null;
        }

        // Get LocalAppData path
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

        // Try primary path structure (newer UEFN versions)
        const primaryPath = path.join(localAppData, "UnrealEditorFortnite", "Saved", "VerseProject", projectName, `${projectName}-Assets`, "Assets.digest.verse");

        if (fs.existsSync(primaryPath)) {
            logger.debug("AssetsDigestParser", `Found Assets.digest.verse at: ${primaryPath}`);
            this.cachedDigestPath = primaryPath;
            return primaryPath;
        }

        // Try fallback path structure (older UEFN versions)
        const fallbackPath = path.join(localAppData, "UnrealEditorFortnite", "Saved", "VerseProject", projectName, "Assets.digest.verse");

        if (fs.existsSync(fallbackPath)) {
            logger.debug("AssetsDigestParser", `Found Assets.digest.verse at fallback location: ${fallbackPath}`);
            this.cachedDigestPath = fallbackPath;
            return fallbackPath;
        }

        logger.debug("AssetsDigestParser", `Assets.digest.verse not found for project: ${projectName}`);
        logger.trace("AssetsDigestParser", `Tried paths:\n  - ${primaryPath}\n  - ${fallbackPath}`);
        return null;
    }

    /**
     * Parses the Assets.digest.verse file and extracts class names.
     */
    async parseAssetsDigest(): Promise<void> {
        const now = Date.now();
        if (this.classNames.size > 0 && now - this.lastParsed < this.CACHE_DURATION) {
            logger.trace("AssetsDigestParser", "Using cached asset class names");
            return;
        }

        const digestPath = await this.getAssetsDigestPath();
        if (!digestPath) {
            return;
        }

        try {
            logger.debug("AssetsDigestParser", `Parsing Assets.digest.verse: ${digestPath}`);
            const content = fs.readFileSync(digestPath, "utf8");

            this.classNames.clear();
            for (const name of AssetsDigestParser.parseDigestContent(content)) {
                this.classNames.add(name);
                logger.trace("AssetsDigestParser", `Found asset type: ${name}`);
            }

            this.lastParsed = now;
            logger.info("AssetsDigestParser", `Parsed ${this.classNames.size} class/struct names from Assets.digest.verse`);
        } catch (error) {
            logger.error("AssetsDigestParser", `Error parsing Assets.digest.verse: ${digestPath}`, error);
        }
    }

    /**
     * Extracts asset type names from Assets.digest.verse content.
     *
     * Recognizes both 41.10 and pre-41.10 declaration shapes:
     * - Class/struct declarations with single, stacked, or argument-bearing
     *   specifiers on either side of `:=`, e.g.
     *   `TestSphere<scoped {...}> := class<final><scoped {...}>(mesh_component):`.
     * - Module-scope asset instances, e.g. `image1<scoped {...}>:texture = external {}`.
     *
     * Declarations nested inside a class or struct body are skipped so that data
     * members (which share the instance declaration shape) are not mistaken for
     * asset names.
     *
     * @param content Raw text of the Assets.digest.verse file.
     * @returns The distinct asset type names, in first-seen order.
     */
    static parseDigestContent(content: string): string[] {
        const names = new Set<string>();
        // Indentation of each open class/struct body, whose members are fields
        // and methods rather than top-level assets.
        const classBodyIndents: number[] = [];

        for (const rawLine of content.split("\n")) {
            const indent = AssetsDigestParser.indentOf(rawLine);
            const line = rawLine.trim();
            if (line === "" || line.startsWith("#")) {
                continue;
            }

            while (classBodyIndents.length > 0 && indent <= classBodyIndents[classBodyIndents.length - 1]) {
                classBodyIndents.pop();
            }

            const classMatch = line.match(CLASS_OR_STRUCT_DECL);
            if (classMatch) {
                names.add(classMatch[1]);
                classBodyIndents.push(indent);
                continue;
            }

            // Instances only count at module scope, never as class/struct members.
            if (classBodyIndents.length === 0) {
                const instanceMatch = line.match(INSTANCE_DECL);
                if (instanceMatch) {
                    names.add(instanceMatch[1]);
                }
            }
        }

        return [...names];
    }

    /**
     * Returns the leading indentation width of a line, counting each tab as four
     * spaces so mixed indentation compares consistently.
     */
    private static indentOf(rawLine: string): number {
        const match = rawLine.match(/^[ \t]*/);
        return match ? match[0].replace(/\t/g, "    ").length : 0;
    }

    /**
     * Checks if a name is a known asset class name (synchronous, uses cache).
     * Call parseAssetsDigest() first to ensure cache is populated.
     */
    isAssetClassName(name: string): boolean {
        return this.classNames.has(name);
    }

    /**
     * Checks if a name is a known asset class name (async, ensures cache is fresh).
     */
    async isAssetClassNameAsync(name: string): Promise<boolean> {
        await this.parseAssetsDigest();
        return this.classNames.has(name);
    }

    /**
     * Ensures the cache is populated. Call this during initialization.
     */
    async ensureCachePopulated(): Promise<void> {
        await this.parseAssetsDigest();
    }

    /**
     * Gets all known asset class names (for debugging).
     */
    getAssetClassNames(): Set<string> {
        return new Set(this.classNames);
    }

    /**
     * Clears the cache and forces a re-parse on next access.
     */
    clearCache(): void {
        this.classNames.clear();
        this.lastParsed = 0;
        this.cachedDigestPath = null;
        logger.debug("AssetsDigestParser", "Cache cleared");
    }

    /**
     * Clears the cache and re-parses immediately.
     *
     * The only consumer, ImportSuggestionExtractor, reads the cache through the
     * synchronous isAssetClassName(), so nothing refills it lazily. Clearing
     * without re-parsing therefore empties the cache for the rest of the
     * session and asset class names stop being recognized.
     */
    private async refreshCache(): Promise<void> {
        this.clearCache();
        await this.parseAssetsDigest();
    }

    /**
     * Queues a refresh for REFRESH_DEBOUNCE_MS after the last watcher event.
     */
    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.refreshCache().catch((error) => {
                logger.error("AssetsDigestParser", "Error refreshing asset class names", error);
            });
        }, AssetsDigestParser.REFRESH_DEBOUNCE_MS);
    }

    /**
     * Cancels a queued refresh so it cannot run after the watchers are disposed.
     */
    private cancelScheduledRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /**
     * Sets up a file watcher for the Assets.digest.verse file.
     * The file changes when assets are modified in UEFN.
     */
    setupFileWatcher(): vscode.Disposable {
        // Create a composite disposable to hold multiple watchers
        const disposables: vscode.Disposable[] = [];

        // Watch for Assets.digest.verse in the VerseProject folder
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        // The digest lives outside the workspace. A plain string glob is only
        // honored inside workspace folders, so watch the external VerseProject
        // directory recursively via a RelativePattern anchored to its Uri.
        const verseProjectDir = path.join(localAppData, "UnrealEditorFortnite", "Saved", "VerseProject");
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(verseProjectDir), "**/Assets.digest.verse"));

        // A create event is the cold-start case: VS Code opened before UEFN had
        // generated the digest, so this is the first moment there is anything to
        // read. A delete event re-parses to nothing, which is correct.
        const handleChange = (uri: vscode.Uri) => {
            logger.debug("AssetsDigestParser", `Assets.digest.verse changed: ${uri.fsPath}`);
            this.scheduleRefresh();
        };

        watcher.onDidChange(handleChange);
        watcher.onDidCreate(handleChange);
        watcher.onDidDelete(handleChange);

        disposables.push(watcher);

        // Also watch for .uefnproject changes: the digest path is derived from
        // the project name, so a rename points the parser at a different file
        // and the class names cached from the previous project are stale.
        const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.uefnproject");
        const handleProjectChange = () => {
            logger.debug("AssetsDigestParser", "Project file changed, refreshing asset class names");
            this.scheduleRefresh();
        };

        projectWatcher.onDidChange(handleProjectChange);
        projectWatcher.onDidCreate(handleProjectChange);
        projectWatcher.onDidDelete(handleProjectChange);

        disposables.push(projectWatcher);

        // Drop any queued refresh on teardown so it cannot run after the
        // extension has been deactivated.
        disposables.push({ dispose: () => this.cancelScheduledRefresh() });

        this.fileWatcher = watcher;

        return vscode.Disposable.from(...disposables);
    }
}

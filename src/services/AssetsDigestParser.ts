import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { logger } from "../utils";
import { singleFlight } from "../utils/singleFlight";
import { DeclarationHead, matchDeclarationHead } from "../utils/verseDeclarationHead";
import { lineIndentWidth, popClosedBlocks } from "../utils/verseText";
import { ProjectPathHandler } from "../project";

/**
 * The right-hand side of an asset instance declaration, read after the head's
 * `:` - a type name, then `= external`. Textures, meshes, and niagara systems
 * are emitted as instances rather than classes in 41.10. The `external` anchor
 * keeps ordinary constant assignments out.
 */
const EXTERNAL_INSTANCE_TAIL = /^\s*\w+\s*=\s*external\b/;

/**
 * Whether the head declares an asset instance rather than a function: a plain
 * typed name whose value is `external`.
 *
 * The parameter-list test is what separates the two, and nothing else does. A
 * module-scope function is written `GetColor<public>()<transacts>:vector3 =
 * external {}`, whose tail is an instance's tail exactly. Recording one here
 * puts a function name into the asset-class set, and
 * `ImportSuggestionExtractor.splitModulePathAndClass` truncates a dotted module
 * path at the first segment that set accepts, so it emits a short `using` path.
 *
 * The receiver test is belt and braces - the caller skips a receiver head
 * already - and is kept so the predicate answers on its own.
 *
 * @param line The trimmed declaration line the head was read from.
 */
function declaresExternalInstance(head: DeclarationHead, line: string): boolean {
    return head.params === null && head.receiver === null && head.operator === ":" && EXTERNAL_INSTANCE_TAIL.test(line.slice(head.end));
}

/**
 * The set of asset type names UEFN generated for this project, read from its
 * Assets.digest.verse.
 *
 * These names are what tells a dotted suggestion where the module ends: in
 * "Did you mean X.Y.Z.ClassName", a segment naming an asset class ends the
 * module path, and that segment onward addresses members rather than modules.
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
     * The project's Assets.digest.verse, or null when there is no project name
     * or no file at either known location.
     *
     * The file lives outside the workspace, under
     * `{LOCALAPPDATA}\UnrealEditorFortnite\Saved\VerseProject\{ProjectName}\`,
     * in a `{ProjectName}-Assets` subfolder on current UEFN and directly in the
     * project folder on older versions.
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

        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

        const primaryPath = path.join(localAppData, "UnrealEditorFortnite", "Saved", "VerseProject", projectName, `${projectName}-Assets`, "Assets.digest.verse");

        if (fs.existsSync(primaryPath)) {
            logger.debug("AssetsDigestParser", `Found Assets.digest.verse at: ${primaryPath}`);
            this.cachedDigestPath = primaryPath;
            return primaryPath;
        }

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
     * Overlapping refresh calls must share one run: the TTL check reads state
     * from before {@link getAssetsDigestPath}'s awaits, so every call that
     * arrives while a parse is in flight passes it and would re-read the file.
     */
    private readonly parseOnce = singleFlight(() => this.doParse());

    /**
     * Refreshes the cached names, doing nothing if they were parsed within
     * CACHE_DURATION or if the digest cannot be located. A file that cannot be
     * read leaves the previously cached names in place. A call that overlaps a
     * running refresh joins it rather than parsing again.
     */
    async parseAssetsDigest(): Promise<void> {
        const now = Date.now();
        if (this.classNames.size > 0 && now - this.lastParsed < this.CACHE_DURATION) {
            logger.trace("AssetsDigestParser", "Using cached asset class names");
            return;
        }

        return this.parseOnce();
    }

    private async doParse(): Promise<void> {
        const now = Date.now();
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
     * Heads are read by `matchDeclarationHead`, shared with the API digest
     * parser and the project scan; the policy over its answer is what lives
     * here, and recognizes both 41.10 and pre-41.10 shapes:
     * - Class/struct declarations, e.g.
     *   `TestSphere<scoped {...}> := class<final><scoped {...}>(mesh_component):`.
     * - Module-scope asset instances, e.g. `image1<scoped {...}>:texture = external {}`.
     *
     * Declarations nested inside a class or struct body are skipped so that data
     * members (which share the instance declaration shape) are not mistaken for
     * asset names.
     *
     * Comments are skipped only where `#` is the line's first non-whitespace
     * character, which is narrower than Verse's own rule: `<# #>` and `<#>`
     * comments, a `#` after code, and a `#` inside a string are all missed.
     * UEFN generates this file and writes only whole-line `#` comments into it,
     * so the narrow rule holds here.
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
            const indent = lineIndentWidth(rawLine);
            const line = rawLine.trim();
            if (line === "" || line.startsWith("#")) {
                continue;
            }

            popClosedBlocks(classBodyIndents, indent);

            const head = matchDeclarationHead(line);
            if (!head || head.receiver !== null) {
                continue;
            }

            if (head.keyword === "class" || head.keyword === "struct") {
                names.add(head.name);
                classBodyIndents.push(indent);
                continue;
            }

            // Instances only count at module scope, never as class/struct members.
            if (classBodyIndents.length === 0 && declaresExternalInstance(head, line)) {
                names.add(head.name);
            }
        }

        return [...names];
    }

    /**
     * Whether the name is a known asset class, answered from the cache alone.
     * Nothing fills that cache lazily, so a caller that has not awaited
     * {@link ensureCachePopulated} gets false for every name.
     */
    isAssetClassName(name: string): boolean {
        return this.classNames.has(name);
    }

    /** As {@link isAssetClassName}, but refreshes the cache first. */
    async isAssetClassNameAsync(name: string): Promise<boolean> {
        await this.parseAssetsDigest();
        return this.classNames.has(name);
    }

    /** Fills the cache so the synchronous {@link isAssetClassName} can answer. */
    async ensureCachePopulated(): Promise<void> {
        await this.parseAssetsDigest();
    }

    /** A copy of the cached names, safe for a caller to keep. */
    getAssetClassNames(): Set<string> {
        return new Set(this.classNames);
    }

    /**
     * Empties the cache and forgets the located digest path, so the next parse
     * searches for the file again.
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
     * Starts watching for asset changes and returns the handle that stops it.
     * Disposing is not optional: it is what cancels a queued refresh that would
     * otherwise run against a deactivated extension.
     */
    setupFileWatcher(): vscode.Disposable {
        const disposables: vscode.Disposable[] = [];

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

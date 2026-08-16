import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils";

/**
 * The part of the on-disk `.uefnproject` JSON this file models. UEFN writes
 * the file, so the optional markers are a guard against an editor version that
 * omits a field, not a statement that the field is rare.
 *
 * Wider than what is actually consumed: only `bindings.projectVersePath`,
 * `bindings.modules` and `title` have readers.
 */
interface UEFNProjectFile {
    bindings?: {
        projectVersePath?: string;
        projectId?: string;
        modules?: Record<string, string>;
    };
    title?: string;
    plugins?: Array<{
        name: string;
        bIsRoot?: boolean;
        bIsPublic?: boolean;
    }>;
}

/**
 * A parsed project file together with the directory it was read from.
 *
 * The directory is what anchors the project's on-disk layout - the Content
 * root sits at `<directory>/Plugins/<root plugin>/Content` - so it has to
 * survive the parse: the parsed JSON alone says where modules are addressed,
 * not where they live.
 */
interface LocatedProjectFile {
    file: UEFNProjectFile;
    directory: string;
}

/**
 * The cache key for a lookup that named no workspace folder. A folder's URI
 * never stringifies to empty, so this cannot collide with one.
 */
const WORKSPACE_SCOPE = "";

/** How far above a folder the search looks for the project file. */
const MAX_PARENT_LEVELS = 5;

/**
 * Resolves the project's Verse path, name and module list from its
 * `.uefnproject` file.
 *
 * A multi-root workspace can hold two UEFN projects, so an answer is only
 * meaningful about a particular file: every accessor takes the resource being
 * worked on and answers for the project that owns it, caching per workspace
 * folder rather than per handler. A caller that names no resource gets the
 * whole-workspace search instead, which is what the activation-time readers
 * need - they identify the workspace, not a file in it.
 */
export class ProjectPathHandler {
    /**
     * The parsed project file per workspace folder, keyed by folder URI.
     *
     * Keyed by the folder searched from rather than the project file found,
     * because the key has to be known before the search that would reveal the
     * file. Two folders under one project therefore hold equal entries, which
     * costs a second parse and never a wrong answer.
     */
    private readonly projectFilesByScope = new Map<string, LocatedProjectFile>();

    constructor(private outputChannel: vscode.OutputChannel) {}

    /**
     * The parsed `.uefnproject` that owns `resource`, or the first one in the
     * workspace when nothing names a folder.
     *
     * Only a success is cached, so in a workspace with no `.uefnproject` every
     * call redoes the folder scan and the parent walk from scratch.
     *
     * @param resource a file in the project being asked about. A resource
     * outside every workspace folder falls back to the whole-workspace search
     * rather than answering nothing.
     */
    async findAndParseProjectFile(resource?: vscode.Uri): Promise<UEFNProjectFile | null> {
        return (await this.findAndLocateProjectFile(resource))?.file ?? null;
    }

    /**
     * The directory holding the `.uefnproject` that owns `resource`, or null
     * when no project file was found. This is the project root the on-disk
     * layout hangs off, which is not necessarily inside any workspace folder -
     * the parent walk can find the file above them all.
     *
     * @param resource a file in the project being asked about. A resource
     * outside every workspace folder falls back to the whole-workspace search
     * rather than answering nothing.
     */
    async getProjectFileDirectory(resource?: vscode.Uri): Promise<string | null> {
        return (await this.findAndLocateProjectFile(resource))?.directory ?? null;
    }

    private async findAndLocateProjectFile(resource?: vscode.Uri): Promise<LocatedProjectFile | null> {
        const scope = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
        const key = scope ? scope.uri.toString() : WORKSPACE_SCOPE;

        const cached = this.projectFilesByScope.get(key);
        if (cached) {
            return cached;
        }

        const projectFile = await this.searchForProjectFile(scope);
        if (projectFile) {
            this.projectFilesByScope.set(key, projectFile);
        }

        return projectFile;
    }

    /**
     * The project file for `scope`, falling back to the whole workspace.
     *
     * The scoped half is what makes a second project in the workspace
     * reachable; the fallback is what keeps a workspace whose first folder
     * holds no project working, since the project can sit in any folder.
     */
    private async searchForProjectFile(scope: vscode.WorkspaceFolder | undefined): Promise<LocatedProjectFile | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            logger.debug("ProjectPathHandler", "No workspace folders found");
            return null;
        }

        if (scope) {
            const own = await this.readProjectFileIn(scope);
            if (own !== undefined) {
                return own;
            }

            const above = await this.walkUpFrom(scope.uri);
            if (above) {
                return above;
            }
        }

        for (const folder of workspaceFolders) {
            // Already searched above, and the answer for a directory does not
            // change within one call, so asking again would only repeat a
            // workspace search that has already come back empty.
            if (scope && folder.uri.toString() === scope.uri.toString()) {
                continue;
            }

            const found = await this.readProjectFileIn(folder);
            if (found !== undefined) {
                return found;
            }
        }

        const above = await this.walkUpFrom(workspaceFolders[0].uri);
        if (!above) {
            logger.debug("ProjectPathHandler", `No .uefnproject file found in workspace or parent directories (checked up to ${MAX_PARENT_LEVELS} levels)`);
        }

        return above;
    }

    /**
     * The project file directly in `folder`.
     *
     * Undefined when the folder holds none, which means the search goes on.
     * Null when it holds one that will not parse, which ends the search:
     * walking on would answer from some parent project's paths, which is worse
     * than answering nothing.
     */
    private async readProjectFileIn(folder: vscode.WorkspaceFolder): Promise<LocatedProjectFile | null | undefined> {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.uefnproject"), null, 1);

        if (files.length === 0) {
            return undefined;
        }

        const projectFilePath = files[0].fsPath;
        logger.debug("ProjectPathHandler", `Found .uefnproject file at: ${projectFilePath}`);

        try {
            return ProjectPathHandler.parseProjectFile(projectFilePath);
        } catch (error) {
            logger.debug("ProjectPathHandler", `Error parsing .uefnproject file: ${error}`);
            return null;
        }
    }

    /**
     * The project file in the nearest of up to five directories above `start`,
     * or null when none of them holds one.
     *
     * UEFN's older project layout nests the Verse code under
     * `<project>/Plugins/<ProjectName>/Content`, so the folder the user opens
     * is often below the project file rather than at it.
     *
     * A file that will not parse only ends its own level here, where it ends
     * the whole search in readProjectFileIn: a directory closer to the file
     * has the better claim to answer, so an unreadable one there is decisive,
     * while one found part-way up should not hide a project above it.
     */
    private async walkUpFrom(start: vscode.Uri): Promise<LocatedProjectFile | null> {
        let currentDir = start.fsPath;

        for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
            const parentDir = path.dirname(currentDir);

            if (parentDir === currentDir) {
                break;
            }

            try {
                const globPattern = new vscode.RelativePattern(vscode.Uri.file(parentDir), "*.uefnproject");
                const files = await vscode.workspace.findFiles(globPattern, null, 1);

                if (files.length > 0) {
                    const projectFilePath = files[0].fsPath;
                    logger.debug("ProjectPathHandler", `Found .uefnproject file in parent directory (${level + 1} level(s) up): ${projectFilePath}`);

                    return ProjectPathHandler.parseProjectFile(projectFilePath);
                }
            } catch (error) {
                logger.debug("ProjectPathHandler", `Error searching parent directory at level ${level + 1}: ${error}`);
            }

            currentDir = parentDir;
        }

        return null;
    }

    /** Raises on an unreadable file and on one that is not JSON alike. */
    private static parseProjectFile(projectFilePath: string): LocatedProjectFile {
        return {
            file: JSON.parse(fs.readFileSync(projectFilePath, "utf8")) as UEFNProjectFile,
            directory: path.dirname(projectFilePath),
        };
    }

    /**
     * The project's Verse path, the prefix every module in it is addressed
     * under: `/vukefn@fortnite.com/MyGame`. Passed through exactly as UEFN
     * wrote it - callers that join onto it add their own separator.
     *
     * @param resource the file the path is wanted for, which is what picks the
     * project in a multi-root workspace.
     */
    async getProjectVersePath(resource?: vscode.Uri): Promise<string | null> {
        const projectFile = await this.findAndParseProjectFile(resource);
        return projectFile?.bindings?.projectVersePath || null;
    }

    /**
     * The project's display title, which is not necessarily the name of the
     * directory holding it.
     *
     * @param resource the file the title is wanted for, which is what picks
     * the project in a multi-root workspace.
     */
    async getProjectName(resource?: vscode.Uri): Promise<string | null> {
        const projectFile = await this.findAndParseProjectFile(resource);
        return projectFile?.title || null;
    }

    /**
     * The name of the plugin `bindings.projectVersePath` addresses, or null
     * when the project file declares no root plugin.
     *
     * UEFN nests a project's Verse under `<project>/Plugins/<name>/Content`,
     * and only the root plugin's Content answers to that path - a second
     * plugin carries a Verse path of its own. So this is what separates a
     * Content root the project's path can address from one it cannot.
     *
     * @param resource the file the plugin is wanted for, which is what picks
     * the project in a multi-root workspace.
     */
    async getRootPluginName(resource?: vscode.Uri): Promise<string | null> {
        const projectFile = await this.findAndParseProjectFile(resource);
        return projectFile?.plugins?.find((plugin) => plugin.bIsRoot)?.name || null;
    }

    /**
     * The project's `bindings.modules` map, verbatim. Nothing in `src/` calls
     * this, so what the keys and values mean is UEFN's to define.
     *
     * @param resource the file the map is wanted for, which is what picks the
     * project in a multi-root workspace.
     */
    async getProjectModules(resource?: vscode.Uri): Promise<Record<string, string> | null> {
        const projectFile = await this.findAndParseProjectFile(resource);
        return projectFile?.bindings?.modules || null;
    }

    /**
     * Drops every folder's parsed project file, so the next read re-runs the
     * search. Clearing one folder would leave the others answering from a file
     * that is no longer on disk.
     */
    clearCache(): void {
        this.projectFilesByScope.clear();
        logger.debug("ProjectPathHandler", "Cleared project path cache");
    }

    /**
     * Starts clearing the cache whenever a `.uefnproject` file is created,
     * changed or deleted. The caller owns the returned watcher and must
     * dispose it.
     */
    setupFileWatcher(): vscode.Disposable {
        const watcher = vscode.workspace.createFileSystemWatcher("**/*.uefnproject");

        const clearCacheHandler = () => {
            this.clearCache();
            logger.debug("ProjectPathHandler", "Project file changed, cache cleared");
        };

        watcher.onDidChange(clearCacheHandler);
        watcher.onDidCreate(clearCacheHandler);
        watcher.onDidDelete(clearCacheHandler);

        return watcher;
    }
}

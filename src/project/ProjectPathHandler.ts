import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils";

/**
 * The subset of the on-disk `.uefnproject` JSON this extension reads. Every
 * field is optional because the file is written by UEFN, not by us, and an
 * older or newer editor may omit any of them.
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
 * Resolves the project's Verse path, name and module list from its
 * `.uefnproject` file.
 *
 * All three cached fields come from a single parse and are cleared together by
 * `clearCache`; leaving one behind would answer from a project file that is no
 * longer on disk.
 */
export class ProjectPathHandler {
    private projectVersePath: string | null = null;
    private projectName: string | null = null;
    private cachedProjectFile: UEFNProjectFile | null = null;

    constructor(private outputChannel: vscode.OutputChannel) {}

    /**
     * The parsed `.uefnproject`, from cache after the first call.
     *
     * Searched in each workspace folder first, then up to five directories
     * above the first one: UEFN's older project layout nests the Verse code
     * under `<project>/Plugins/<ProjectName>/Content`, so the folder the user
     * opens is often below the project file rather than at it.
     */
    async findAndParseProjectFile(): Promise<UEFNProjectFile | null> {
        if (this.cachedProjectFile) {
            return this.cachedProjectFile;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            logger.debug("ProjectPathHandler", "No workspace folders found");
            return null;
        }

        for (const folder of workspaceFolders) {
            const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.uefnproject"), null, 1);

            if (files.length > 0) {
                const projectFilePath = files[0].fsPath;
                logger.debug("ProjectPathHandler", `Found .uefnproject file at: ${projectFilePath}`);

                try {
                    const content = fs.readFileSync(projectFilePath, "utf8");
                    this.cachedProjectFile = JSON.parse(content) as UEFNProjectFile;

                    if (this.cachedProjectFile.bindings?.projectVersePath) {
                        this.projectVersePath = this.cachedProjectFile.bindings.projectVersePath;
                        logger.debug("ProjectPathHandler", `Project Verse path: ${this.projectVersePath}`);
                    }

                    if (this.cachedProjectFile.title) {
                        this.projectName = this.cachedProjectFile.title;
                    }

                    return this.cachedProjectFile;
                } catch (error) {
                    // A project file that exists but will not parse ends the
                    // search. Walking on would answer from some parent
                    // project's paths, which is worse than answering nothing.
                    logger.debug("ProjectPathHandler", `Error parsing .uefnproject file: ${error}`);
                    return null;
                }
            }
        }

        const firstWorkspace = workspaceFolders[0];
        let currentDir = firstWorkspace.uri.fsPath;
        const maxLevels = 5;

        for (let level = 0; level < maxLevels; level++) {
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

                    const content = fs.readFileSync(projectFilePath, "utf8");
                    this.cachedProjectFile = JSON.parse(content) as UEFNProjectFile;

                    if (this.cachedProjectFile.bindings?.projectVersePath) {
                        this.projectVersePath = this.cachedProjectFile.bindings.projectVersePath;
                        logger.debug("ProjectPathHandler", `Project Verse path: ${this.projectVersePath}`);
                    }

                    if (this.cachedProjectFile.title) {
                        this.projectName = this.cachedProjectFile.title;
                    }

                    return this.cachedProjectFile;
                }
            } catch (error) {
                logger.debug("ProjectPathHandler", `Error searching parent directory at level ${level + 1}: ${error}`);
            }

            currentDir = parentDir;
        }

        logger.debug("ProjectPathHandler", "No .uefnproject file found in workspace or parent directories (checked up to 5 levels)");
        return null;
    }

    /**
     * The project's Verse path, the prefix every module in it is addressed
     * under: `/vukefn@fortnite.com/MyGame`, no trailing slash.
     */
    async getProjectVersePath(): Promise<string | null> {
        if (this.projectVersePath) {
            return this.projectVersePath;
        }

        const projectFile = await this.findAndParseProjectFile();
        return projectFile?.bindings?.projectVersePath || null;
    }

    /**
     * The project's display title, which is not necessarily the name of the
     * directory holding it.
     */
    async getProjectName(): Promise<string | null> {
        if (this.projectName) {
            return this.projectName;
        }

        const projectFile = await this.findAndParseProjectFile();
        return projectFile?.title || null;
    }

    /**
     * The project's module bindings, keyed by module name.
     */
    async getProjectModules(): Promise<Record<string, string> | null> {
        const projectFile = await this.findAndParseProjectFile();
        return projectFile?.bindings?.modules || null;
    }

    /**
     * Drops the parsed project file and everything derived from it, so the
     * next read re-runs the search.
     */
    clearCache(): void {
        this.cachedProjectFile = null;
        this.projectVersePath = null;
        this.projectName = null;
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

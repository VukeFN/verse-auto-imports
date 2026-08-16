import * as fs from "fs";
import * as vscode from "vscode";
import { ProjectPathHandler } from "../ProjectPathHandler";

/**
 * Regression tests for issue #376: project identity was watched through three
 * independent string-glob watchers, and a string glob reports nothing outside
 * the workspace folders - where the UEFN-generated multi-root workspace keeps
 * the `.uefnproject`. The handler is now the one watcher owner: it anchors a
 * watcher to a project directory discovered outside the workspace folders and
 * broadcasts every project event through onDidChangeProject.
 */
describe("ProjectPathHandler project watching", () => {
    /** The subset of the mock watcher these tests drive. */
    interface FakeWatcher {
        globPattern: unknown;
        disposed: boolean;
        fireChange(fsPath: string): void;
        fireDelete(fsPath: string): void;
    }

    const IN_WORKSPACE_ROOT = "/workspace/first";
    /** The UEFN shape: the opened folder is the project's Content directory. */
    const CONTENT_ROOT = "/project/Content";
    const PROJECT_ROOT = "/project";

    const PROJECT = {
        title: "MyGame",
        bindings: { projectVersePath: "/mygame@fortnite.com/mygame" },
    };

    const createFileSystemWatcher = vscode.workspace.createFileSystemWatcher as unknown as jest.Mock;

    /** Directory holding a `.uefnproject` -> its parsed content. */
    let projectsByDirectory: Map<string, unknown>;
    /** Project files read, in order, so a cache clear can be told from a hit. */
    let reads: string[];
    let handler: ProjectPathHandler;

    const forwardSlashed = (fsPath: string) => fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const projectPathIn = (directory: string) => `${directory}/Project.uefnproject`;

    const givenWorkspaceFolders = (...roots: string[]): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = roots.map((root, index) => ({
            uri: vscode.Uri.file(root),
            name: root.split("/").pop() ?? root,
            index,
        }));
    };

    const givenProjectsIn = (byDirectory: Record<string, unknown>): void => {
        projectsByDirectory = new Map(Object.entries(byDirectory));
    };

    const allWatchers = (): FakeWatcher[] => createFileSystemWatcher.mock.results.map((result) => result.value as FakeWatcher);

    /** The watchers anchored to a directory, told apart from the string glob. */
    const anchoredWatchers = (): FakeWatcher[] => allWatchers().filter((watcher) => typeof watcher.globPattern !== "string");

    const anchoredPattern = (watcher: FakeWatcher) => watcher.globPattern as { base: { fsPath: string }; pattern: string };

    beforeEach(() => {
        reads = [];
        projectsByDirectory = new Map();

        (vscode.workspace.findFiles as jest.Mock).mockImplementation(async (pattern: { base: { uri?: { fsPath: string }; fsPath?: string } }) => {
            const base = pattern.base.uri ?? (pattern.base as { fsPath: string });
            const directory = forwardSlashed(base.fsPath);

            return projectsByDirectory.has(directory) ? [vscode.Uri.file(projectPathIn(directory))] : [];
        });

        (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (target: { fsPath: string }) => {
            const directory = forwardSlashed(target.fsPath);

            return projectsByDirectory.has(directory) ? [["Project.uefnproject", vscode.FileType.File]] : [];
        });

        jest.spyOn(fs, "readFileSync").mockImplementation(((target: string): string => {
            const requested = forwardSlashed(String(target));
            reads.push(requested);

            const project = projectsByDirectory.get(requested.replace(/\/Project\.uefnproject$/, ""));
            if (project === undefined) {
                throw new Error(`ENOENT: ${requested}`);
            }

            return JSON.stringify(project);
        }) as unknown as typeof fs.readFileSync);

        createFileSystemWatcher.mockClear();
        handler = new ProjectPathHandler(vscode.window.createOutputChannel("test"));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        (vscode.workspace.findFiles as jest.Mock).mockReset().mockResolvedValue([]);
        (vscode.workspace.fs.readDirectory as jest.Mock).mockReset().mockRejectedValue(new Error("ENOENT"));
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    it("clears the cache and fires onDidChangeProject on a project event", async () => {
        givenWorkspaceFolders(IN_WORKSPACE_ROOT);
        givenProjectsIn({ [IN_WORKSPACE_ROOT]: PROJECT });
        const watching = handler.setupFileWatcher();
        let events = 0;
        handler.onDidChangeProject(() => events++);

        expect(await handler.getProjectName()).toBe("MyGame");
        reads = [];

        allWatchers()[0].fireChange(projectPathIn(IN_WORKSPACE_ROOT));
        expect(events).toBe(1);

        // The re-read is the cache clear made visible.
        expect(await handler.getProjectName()).toBe("MyGame");
        expect(reads).toEqual([projectPathIn(IN_WORKSPACE_ROOT)]);

        allWatchers()[0].fireDelete(projectPathIn(IN_WORKSPACE_ROOT));
        expect(events).toBe(2);

        watching.dispose();
    });

    it("anchors a watcher to a project directory outside the workspace folders", async () => {
        givenWorkspaceFolders(CONTENT_ROOT);
        givenProjectsIn({ [PROJECT_ROOT]: PROJECT });
        const watching = handler.setupFileWatcher();
        let events = 0;
        handler.onDidChangeProject(() => events++);

        expect(await handler.getProjectName()).toBe("MyGame");

        const anchored = anchoredWatchers();
        expect(anchored).toHaveLength(1);
        expect(forwardSlashed(anchoredPattern(anchored[0]).base.fsPath)).toBe(PROJECT_ROOT);
        expect(anchoredPattern(anchored[0]).pattern).toBe("*.uefnproject");

        reads = [];
        anchored[0].fireChange(projectPathIn(PROJECT_ROOT));
        expect(events).toBe(1);
        expect(await handler.getProjectName()).toBe("MyGame");
        expect(reads).toEqual([projectPathIn(PROJECT_ROOT)]);

        watching.dispose();
    });

    it("does not anchor a directory the string glob already covers", async () => {
        givenWorkspaceFolders(IN_WORKSPACE_ROOT);
        givenProjectsIn({ [IN_WORKSPACE_ROOT]: PROJECT });
        const watching = handler.setupFileWatcher();

        await handler.getProjectName();

        // A second watcher there would double every subscriber's reaction.
        expect(createFileSystemWatcher).toHaveBeenCalledTimes(1);

        watching.dispose();
    });

    it("anchors a discovery that finished before watching started", async () => {
        givenWorkspaceFolders(CONTENT_ROOT);
        givenProjectsIn({ [PROJECT_ROOT]: PROJECT });

        // Activation kicks discovery off before the watcher wiring runs, so
        // the anchor has to be picked up from the cache at setup.
        expect(await handler.getProjectName()).toBe("MyGame");
        expect(createFileSystemWatcher).not.toHaveBeenCalled();

        const watching = handler.setupFileWatcher();
        let events = 0;
        handler.onDidChangeProject(() => events++);

        const anchored = anchoredWatchers();
        expect(anchored).toHaveLength(1);
        anchored[0].fireChange(projectPathIn(PROJECT_ROOT));
        expect(events).toBe(1);

        watching.dispose();
    });

    it("tears down anchored watchers on dispose and stops anchoring", async () => {
        givenWorkspaceFolders(CONTENT_ROOT);
        givenProjectsIn({ [PROJECT_ROOT]: PROJECT });
        const watching = handler.setupFileWatcher();
        await handler.getProjectName();
        const anchored = anchoredWatchers();
        expect(anchored).toHaveLength(1);
        let events = 0;
        handler.onDidChangeProject(() => events++);

        watching.dispose();

        expect(anchored[0].disposed).toBe(true);
        anchored[0].fireChange(projectPathIn(PROJECT_ROOT));
        expect(events).toBe(0);

        // A discovery after teardown must not start new watchers.
        handler.clearCache();
        await handler.getProjectName();
        expect(anchoredWatchers()).toHaveLength(1);
    });
});

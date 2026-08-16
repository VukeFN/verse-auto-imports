import * as fs from "fs";
import * as vscode from "vscode";
import { ProjectPathHandler } from "../project";
import { AssetsDigestParser, ProjectPathCache } from "../services";

/**
 * Regression test for issue #376 at the wiring the extension activates: in the
 * UEFN-generated multi-root workspace the `.uefnproject` sits outside every
 * workspace folder, and a mid-session change to it - a rename, UEFN rewriting
 * bindings - must still reach all three identity consumers. Before the fix
 * each component watched `**\/*.uefnproject` with its own string glob, which
 * reports nothing outside the workspace folders, so the change was never
 * observed and the stale identity was served for the rest of the session.
 */
describe("project identity change in the UEFN multi-root shape", () => {
    /** The subset of the mock watcher this test drives. */
    interface FakeWatcher {
        globPattern: unknown;
        fireChange(fsPath: string): void;
    }

    /** Minimal in-memory stand-in for vscode.Memento (workspaceState). */
    class FakeMemento {
        private readonly store: Map<string, unknown> = new Map();

        get<T>(key: string): T | undefined {
            return this.store.get(key) as T | undefined;
        }

        async update(key: string, value: unknown): Promise<void> {
            if (value === undefined) {
                this.store.delete(key);
            } else {
                this.store.set(key, value);
            }
        }
    }

    const CONTENT_ROOT = "/project/Content";
    const PROJECT_ROOT = "/project";
    const PROJECT_FILE = `${PROJECT_ROOT}/Project.uefnproject`;

    const createFileSystemWatcher = vscode.workspace.createFileSystemWatcher as unknown as jest.Mock;

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    /** The title the `.uefnproject` currently carries; the test renames it. */
    let projectTitle: string;
    /** Digest paths the parser has read, so a re-resolve can be asserted. */
    let digestReads: string[];

    const forwardSlashed = (fsPath: string) => fsPath.replace(/\\/g, "/").replace(/\/+$/, "");

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        (vscode.workspace.fs.readDirectory as jest.Mock).mockReset().mockRejectedValue(new Error("ENOENT"));
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    it("a .uefnproject rename outside the workspace folders reaches identity, cache and digest", async () => {
        jest.useFakeTimers();
        projectTitle = "MyGame";
        digestReads = [];

        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(CONTENT_ROOT), name: "Content", index: 0 }];

        // The project file is reachable only by walking up from the Content
        // folder; findFiles keeps its mock default of finding nothing, which
        // is also what the scan sees (a project with no .verse files yet).
        (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (target: { fsPath: string }) => {
            return forwardSlashed(target.fsPath) === PROJECT_ROOT ? [["Project.uefnproject", vscode.FileType.File]] : [];
        });

        jest.spyOn(fs, "existsSync").mockImplementation((target) => String(target).endsWith("Assets.digest.verse") && String(target).includes(projectTitle));
        jest.spyOn(fs, "readFileSync").mockImplementation(((target: string): string => {
            const requested = forwardSlashed(String(target));
            if (requested === PROJECT_FILE) {
                return JSON.stringify({ title: projectTitle, bindings: { projectVersePath: `/mygame@fortnite.com/${projectTitle.toLowerCase()}` } });
            }
            digestReads.push(requested);
            return "SomeAsset := class(material):";
        }) as unknown as typeof fs.readFileSync);

        const outputChannel = vscode.window.createOutputChannel("test");
        const handler = new ProjectPathHandler(outputChannel);
        const parser = new AssetsDigestParser(outputChannel, handler);
        const cache = new ProjectPathCache({ workspaceState: new FakeMemento() } as unknown as CacheParams[0], outputChannel as unknown as CacheParams[1], handler);

        // Activation order: both caches start populating off the activation
        // path, then the watcher wiring runs, as in extension.ts.
        const populated = parser.ensureCachePopulated();
        const initialized = cache.initialize();
        const subscriptions = [handler.setupFileWatcher(), parser.setupFileWatcher(), cache.setupFileWatchers()];
        await populated;
        await initialized;

        expect(cache.getStats().loaded).toBe(true);
        expect(cache.getStats().projectName).toBe("MyGame");
        expect(digestReads.some((read) => read.includes("MyGame"))).toBe(true);

        // The handler anchored a watcher to the project's own directory; the
        // string-glob watchers cannot fire for it.
        const anchored = createFileSystemWatcher.mock.results
            .map((result) => result.value as FakeWatcher)
            .filter((watcher) => (watcher.globPattern as { pattern?: string }).pattern === "*.uefnproject");
        expect(anchored).toHaveLength(1);

        // UEFN rewrites the project file mid-session: a rename.
        projectTitle = "RenamedGame";
        digestReads = [];
        anchored[0].fireChange(PROJECT_FILE);
        await jest.advanceTimersByTimeAsync(1000);

        expect(await handler.getProjectName()).toBe("RenamedGame");
        expect(cache.getStats().projectName).toBe("RenamedGame");
        expect(digestReads.some((read) => read.includes("RenamedGame"))).toBe(true);

        subscriptions.forEach((subscription) => subscription.dispose());
    });
});

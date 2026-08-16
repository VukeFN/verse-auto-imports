import * as vscode from "vscode";
import { ProjectPathCache } from "../ProjectPathCache";

/**
 * Regression tests for issue #146: a first build that finds no UEFN project
 * must not leave the cache permanently disengaged.
 *
 * The workspace can be opened before the .uefnproject file exists, or with it
 * further up than the scanner searches. The scan then yields nothing, and the
 * cache used to latch `initialized` anyway and ignore the project file being
 * created, so every module lookup missed for the rest of the session and only
 * a manual rebuild or a window reload recovered.
 *
 * These run against stub VS Code workspace APIs, so no extension host is needed.
 */
describe("ProjectPathCache recovery after an empty first build", () => {
    /** The subset of the mock watcher these tests inspect. */
    interface FakeWatcher {
        globPattern: unknown;
    }

    const createFileSystemWatcher = vscode.workspace.createFileSystemWatcher as unknown as jest.Mock;

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

    /**
     * Stands in for ProjectPathHandler. `projectName` starts null - the state
     * that makes ProjectPathScanner.scanProject return null - and the tests
     * flip it to model the .uefnproject becoming discoverable.
     * fireProjectChanged models the handler observing a .uefnproject event.
     */
    class FakeProjectPathHandler {
        projectName: string | null = null;
        private readonly listeners: Array<() => void> = [];

        readonly onDidChangeProject = (listener: () => void) => {
            this.listeners.push(listener);
            return { dispose: jest.fn() };
        };

        fireProjectChanged(): void {
            for (const listener of this.listeners) {
                listener();
            }
        }

        async getProjectName(): Promise<string | null> {
            return this.projectName;
        }

        async getProjectVersePath(): Promise<string | null> {
            return this.projectName ? "/mygame@fortnite.com/mygame" : null;
        }
    }

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    let handler: FakeProjectPathHandler;
    let cache: ProjectPathCache;

    /** Drains the microtask queue so fire-and-forget rebuilds settle. */
    const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    beforeEach(() => {
        jest.clearAllMocks();

        setWorkspaceFolders([{ uri: { fsPath: "C:\\Project\\Content" }, name: "Content", index: 0 }]);

        handler = new FakeProjectPathHandler();
        cache = new ProjectPathCache({ workspaceState: new FakeMemento() } as unknown as CacheParams[0], { appendLine: jest.fn() } as unknown as CacheParams[1], handler as unknown as CacheParams[2]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
    });

    it("rebuilds on a later initialize when the first build found no project", async () => {
        await cache.initialize();
        expect(cache.getStats().loaded).toBe(false);

        // The .uefnproject is now discoverable.
        handler.projectName = "MyGame";

        await cache.initialize();

        expect(cache.getStats().loaded).toBe(true);
    });

    it("rebuilds when the project appears after startup", async () => {
        await cache.initialize();
        expect(cache.getStats().loaded).toBe(false);

        cache.setupFileWatchers();

        // The cache watches only .verse files itself; .uefnproject events
        // arrive as ProjectPathHandler's project-changed event, so the
        // create-after-startup recovery rides that signal.
        const watchers = createFileSystemWatcher.mock.results.map((result) => result.value as FakeWatcher);
        expect(watchers).toHaveLength(1);
        expect(watchers[0].globPattern).toBe("**/*.verse");

        handler.projectName = "MyGame";
        handler.fireProjectChanged();
        await flushAsync();

        expect(cache.getStats().loaded).toBe(true);
    });

    it("keeps the cache engaged once a build has produced data", async () => {
        handler.projectName = "MyGame";

        await cache.initialize();

        expect(cache.getStats().loaded).toBe(true);

        // A second initialize must not re-scan once data is held.
        const findFiles = vscode.workspace.findFiles as jest.Mock;
        const callsAfterFirstBuild = findFiles.mock.calls.length;
        await cache.initialize();

        expect(findFiles.mock.calls.length).toBe(callsAfterFirstBuild);
        expect(cache.getStats().loaded).toBe(true);
    });
});

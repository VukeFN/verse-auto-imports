import * as vscode from "vscode";
import { ProjectPathCache } from "../ProjectPathCache";
import { PROJECT_CACHE_VERSION, SerializedProjectPathCache } from "../../types";

/**
 * Regression tests for issue #135: cache.watcherDebounceMs and
 * cache.autoRebuildOnStartup were declared in package.json, validated by the
 * settings UI and announced in the 0.7.0 changelog, but no code path read
 * either. The watcher debounce was a hardcoded 500ms constant, and initialize()
 * always preferred the stored payload, so a user tuning the debounce or asking
 * for a fresh cache at startup got nothing.
 *
 * These drive the cache against stub VS Code workspace APIs, so no extension
 * host is needed.
 */
describe("ProjectPathCache settings", () => {
    /** The subset of the mock watcher these tests drive. */
    interface FakeWatcher {
        globPattern: unknown;
        fireChange(fsPath: string): void;
    }

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    /** ProjectPathCache's own storage key; kept in sync with its private static. */
    const CACHE_KEY = "projectPathTree";

    const getConfiguration = vscode.workspace.getConfiguration as unknown as jest.Mock;
    const createFileSystemWatcher = vscode.workspace.createFileSystemWatcher as unknown as jest.Mock;
    const findFiles = vscode.workspace.findFiles as unknown as jest.Mock;

    /** Minimal in-memory stand-in for vscode.Memento (workspaceState). */
    class FakeMemento {
        constructor(private readonly store: Map<string, unknown> = new Map()) {}

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

    /** Stands in for ProjectPathHandler; a name is all the scan needs to succeed. */
    class FakeProjectPathHandler {
        async getProjectName(): Promise<string | null> {
            return "MyGame";
        }

        async getProjectVersePath(): Promise<string | null> {
            return "/mygame@fortnite.com/mygame";
        }
    }

    /** A stored payload holding one declaration, so a load is visible in the stats. */
    const STORED_CACHE: SerializedProjectPathCache = {
        version: PROJECT_CACHE_VERSION,
        projectName: "MyGame",
        projectVersePath: "/mygame@fortnite.com/mygame",
        generatedAt: 0,
        nodes: [{ name: "device_module", fullPath: "device_module", type: "module", isPublic: true, sourceFile: "Scripts/device.verse", sourceLine: 1 }],
    };

    /** The shared configuration stub, restored after every test. */
    const originalConfiguration = getConfiguration.getMockImplementation();

    /**
     * Answers the named settings explicitly and falls through to the passed
     * fallback for everything else, the way the shared mock does.
     */
    const stubSettings = (settings: Record<string, unknown>): void => {
        getConfiguration.mockReturnValue({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key in settings ? settings[key] : defaultValue)),
            update: jest.fn().mockResolvedValue(undefined),
        });
    };

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    const makeCache = (stored: Record<string, unknown> = {}): ProjectPathCache =>
        new ProjectPathCache(
            { workspaceState: new FakeMemento(new Map(Object.entries(stored))) } as unknown as CacheParams[0],
            { appendLine: jest.fn() } as unknown as CacheParams[1],
            new FakeProjectPathHandler() as unknown as CacheParams[2],
        );

    beforeEach(() => {
        jest.clearAllMocks();
        setWorkspaceFolders([{ uri: { fsPath: "C:\\Project\\Content" }, name: "Content", index: 0 }]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        getConfiguration.mockReset();
        if (originalConfiguration) {
            getConfiguration.mockImplementation(originalConfiguration);
        }
        jest.useRealTimers();
    });

    describe("cache.watcherDebounceMs", () => {
        /**
         * Arms the watcher debounce on a file change and reports when the
         * invalidation it guards actually runs.
         */
        const armDebounce = (cache: ProjectPathCache): jest.SpyInstance => {
            const invalidateFiles = jest.spyOn(cache, "invalidateFiles").mockResolvedValue(undefined);
            cache.setupFileWatchers();

            // Watchers are created in order: **/*.verse first, then **/*.uefnproject.
            const verseWatcher = createFileSystemWatcher.mock.results.map((result) => result.value as FakeWatcher)[0];
            expect(verseWatcher.globPattern).toBe("**/*.verse");
            verseWatcher.fireChange("C:\\Project\\Content\\Scripts\\device.verse");

            return invalidateFiles;
        };

        it("waits the configured delay rather than the built-in 500ms", async () => {
            jest.useFakeTimers();
            stubSettings({ "cache.watcherDebounceMs": 2000 });

            const invalidateFiles = armDebounce(makeCache());

            jest.advanceTimersByTime(500);
            expect(invalidateFiles).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1500);
            expect(invalidateFiles).toHaveBeenCalledWith(["Scripts/device.verse"]);
        });

        it("falls back to 500ms, the default package.json registers", async () => {
            jest.useFakeTimers();
            stubSettings({});

            const invalidateFiles = armDebounce(makeCache());

            jest.advanceTimersByTime(499);
            expect(invalidateFiles).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(invalidateFiles).toHaveBeenCalledWith(["Scripts/device.verse"]);
        });

        it("re-reads the setting for each change, so a new value needs no window reload", async () => {
            jest.useFakeTimers();
            const settings: Record<string, unknown> = { "cache.watcherDebounceMs": 500 };
            getConfiguration.mockReturnValue({
                get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key in settings ? settings[key] : defaultValue)),
                update: jest.fn().mockResolvedValue(undefined),
            });

            const cache = makeCache();
            const invalidateFiles = armDebounce(cache);
            jest.advanceTimersByTime(500);
            expect(invalidateFiles).toHaveBeenCalledTimes(1);

            // The user raises the delay; the next change must honour it.
            settings["cache.watcherDebounceMs"] = 3000;
            const verseWatcher = createFileSystemWatcher.mock.results.map((result) => result.value as FakeWatcher)[0];
            verseWatcher.fireChange("C:\\Project\\Content\\Scripts\\other.verse");

            jest.advanceTimersByTime(500);
            expect(invalidateFiles).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(2500);
            expect(invalidateFiles).toHaveBeenCalledTimes(2);
        });
    });

    describe("cache.autoRebuildOnStartup", () => {
        it("scans the project instead of loading the stored cache when on", async () => {
            stubSettings({ "cache.autoRebuildOnStartup": true });
            findFiles.mockResolvedValue([]);

            const cache = makeCache({ [CACHE_KEY]: STORED_CACHE });
            await cache.initialize();

            expect(findFiles).toHaveBeenCalled();
            // The scan found no files, so the stored declaration is gone: what
            // the cache holds came from the rebuild, not from storage.
            expect(cache.getStats().files).toBe(0);
        });

        it("loads the stored cache when off", async () => {
            stubSettings({ "cache.autoRebuildOnStartup": false });
            findFiles.mockResolvedValue([]);

            const cache = makeCache({ [CACHE_KEY]: STORED_CACHE });
            await cache.initialize();

            expect(findFiles).not.toHaveBeenCalled();
            expect(cache.getStats().files).toBe(1);
        });

        it("still builds fresh when it is off and storage holds nothing", async () => {
            stubSettings({ "cache.autoRebuildOnStartup": false });
            findFiles.mockResolvedValue([]);

            const cache = makeCache();
            await cache.initialize();

            expect(findFiles).toHaveBeenCalled();
        });
    });
});

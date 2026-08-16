import * as vscode from "vscode";
import { ProjectPathCache } from "../ProjectPathCache";
import { logger } from "../../utils";

/**
 * Regression tests for issue #137: invalidateFiles parses while the cache can be
 * cleared underneath it.
 *
 * The debounced update parses each changed file, then commits the new nodes.
 * Three paths null the cache during those parses - the project-changed
 * subscriber, the watcher-teardown hook, and the Clear Project Path Cache
 * command - and the
 * commit used to dereference the field again afterwards. Nothing awaited the
 * debounce callback, so the resulting TypeError surfaced as an unhandled
 * rejection in the extension host, the pending update was lost, and workspace
 * storage kept the pre-edit nodes.
 *
 * These drive the cache against stub VS Code workspace APIs, so no extension
 * host is needed.
 */
describe("ProjectPathCache.invalidateFiles when the cache changes mid-parse", () => {
    /** The subset of the mock watcher these tests drive. */
    interface FakeWatcher {
        globPattern: unknown;
        fireChange(fsPath: string): void;
    }

    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    const createFileSystemWatcher = vscode.workspace.createFileSystemWatcher as unknown as jest.Mock;

    /** A module declaration, so a successful parse yields a node to commit. */
    const VERSE_SOURCE = "device_module := module:\n";

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

    /** Stands in for ProjectPathHandler; a name is all scanProject needs to succeed. */
    class FakeProjectPathHandler {
        readonly onDidChangeProject = () => ({ dispose: jest.fn() });

        async getProjectName(): Promise<string | null> {
            return "MyGame";
        }

        async getProjectVersePath(): Promise<string | null> {
            return "/mygame@fortnite.com/mygame";
        }
    }

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    /** ProjectPathCache's own storage key; kept in sync with its private static. */
    const CACHE_KEY = "projectPathTree";

    let cache: ProjectPathCache;
    let storage: FakeMemento;

    /** The node count in the payload workspace storage currently holds. */
    const persistedNodeCount = (): number => storage.get<{ nodes: unknown[] }>(CACHE_KEY)?.nodes.length ?? -1;

    /** Drains the microtask queue so an in-flight parse reaches its await. */
    const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    /**
     * Parks every parse until the returned release() is called, so a test can
     * act on the cache while invalidateFiles sits on its await.
     */
    const gateParsing = (): (() => void) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        openTextDocument.mockImplementation(async () => {
            await gate;
            return { getText: () => VERSE_SOURCE };
        });
        return () => release();
    };

    beforeEach(async () => {
        jest.clearAllMocks();
        openTextDocument.mockResolvedValue({ getText: () => VERSE_SOURCE });

        setWorkspaceFolders([{ uri: { fsPath: "C:\\Project\\Content" }, name: "Content", index: 0 }]);

        storage = new FakeMemento();
        cache = new ProjectPathCache(
            { workspaceState: storage } as unknown as CacheParams[0],
            { appendLine: jest.fn() } as unknown as CacheParams[1],
            new FakeProjectPathHandler() as unknown as CacheParams[2],
        );

        await cache.initialize();
        expect(cache.getStats().loaded).toBe(true);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        openTextDocument.mockResolvedValue({ getText: () => "" });
    });

    it("resolves instead of throwing when the cache is cleared during the parse", async () => {
        const release = gateParsing();

        const pending = cache.invalidateFiles(["Scripts/device.verse"]);
        await flushAsync();

        // The Clear Project Path Cache command, or the project-changed subscriber.
        cache.clear();
        release();

        await expect(pending).resolves.toBeUndefined();
        expect(cache.getStats().loaded).toBe(false);
    });

    it("discards the parsed nodes when a rebuild replaces the cache during the parse", async () => {
        const release = gateParsing();

        const pending = cache.invalidateFiles(["Scripts/device.verse"]);
        await flushAsync();

        // What the project-changed subscriber does: clear, then rebuild. The
        // rebuild scans every file itself, so the in-flight parse is stale by then.
        cache.clear();
        await cache.rebuildCache();
        release();
        await pending;

        expect(cache.getStats().loaded).toBe(true);
        expect(cache.getStats().files).toBe(0);
        // Workspace storage holds the rebuild's payload, not one carrying the
        // stale node - the next session loads what the rebuild found.
        expect(persistedNodeCount()).toBe(0);
    });

    it("still commits the parsed nodes when nothing disturbs the cache", async () => {
        await cache.invalidateFiles(["Scripts/device.verse"]);

        expect(cache.getStats().files).toBe(1);
        expect(cache.getStats().identifiers).toBe(1);
        expect(persistedNodeCount()).toBe(1);
    });

    it("logs a failed invalidation from the debounce timer instead of leaving it unhandled", async () => {
        jest.useFakeTimers();
        const errors = jest.spyOn(logger, "error").mockImplementation(() => {});
        const failure = new Error("parse exploded");
        jest.spyOn(cache, "invalidateFiles").mockRejectedValue(failure);

        try {
            cache.setupFileWatchers();

            // The .verse watcher is the only one the cache creates itself.
            const verseWatcher = createFileSystemWatcher.mock.results.map((result) => result.value as FakeWatcher)[0];
            expect(verseWatcher.globPattern).toBe("**/*.verse");

            verseWatcher.fireChange("C:\\Project\\Content\\Scripts\\device.verse");
            jest.advanceTimersByTime(500);
            await Promise.resolve();
            await Promise.resolve();

            expect(errors).toHaveBeenCalledWith("ProjectPathCache", "Failed to invalidate changed files", failure);
        } finally {
            // The logger is a singleton, so leaving the stub installed would
            // silently swallow errors in any test added after this one.
            jest.restoreAllMocks();
            jest.useRealTimers();
        }
    });
});

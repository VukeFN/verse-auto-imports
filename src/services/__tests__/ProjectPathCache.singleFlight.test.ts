import * as vscode from "vscode";
import { ProjectPathCache } from "../ProjectPathCache";

/**
 * Regression tests for issue #377: rebuildCache had no in-flight guard and
 * committed in completion order.
 *
 * Two overlapping rebuild requests each ran a full scan, and a rebuild that
 * resolved after a newer one - a slow initial scan racing the user's rebuild
 * command, or the .uefnproject watcher's clear-and-rebuild - overwrote the
 * newer result in memory and persisted the regression to workspace storage,
 * where the next session restored it.
 */
describe("ProjectPathCache.rebuildCache under concurrent invocation", () => {
    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    const findFiles = vscode.workspace.findFiles as unknown as jest.Mock;

    /** A module declaration, so a scanned file yields a node to commit. */
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

    /**
     * Stands in for ProjectPathHandler, with a gate the next scan parks on:
     * scanProject awaits getProjectVersePath first, so arming the gate holds
     * that scan mid-flight while the test acts on the cache.
     */
    class GateableProjectPathHandler {
        private gate: Promise<void> | null = null;
        private release: () => void = () => {};

        armGate(): () => void {
            this.gate = new Promise<void>((resolve) => {
                this.release = resolve;
            });
            return () => this.release();
        }

        async getProjectVersePath(): Promise<string | null> {
            const gate = this.gate;
            if (gate) {
                this.gate = null;
                await gate;
            }
            return "/mygame@fortnite.com/mygame";
        }

        async getProjectName(): Promise<string | null> {
            return "MyGame";
        }
    }

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    /** ProjectPathCache's own storage key; kept in sync with its private static. */
    const CACHE_KEY = "projectPathTree";

    let cache: ProjectPathCache;
    let storage: FakeMemento;
    let handler: GateableProjectPathHandler;

    /** The node count in the payload workspace storage currently holds. */
    const persistedNodeCount = (): number => storage.get<{ nodes: unknown[] }>(CACHE_KEY)?.nodes.length ?? -1;

    /** Drains the microtask queue so an in-flight scan reaches its await. */
    const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        findFiles.mockResolvedValue([]);
        openTextDocument.mockResolvedValue({ getText: () => VERSE_SOURCE });

        setWorkspaceFolders([{ uri: { fsPath: "C:\\Project\\Content" }, name: "Content", index: 0 }]);

        storage = new FakeMemento();
        handler = new GateableProjectPathHandler();
        cache = new ProjectPathCache({ workspaceState: storage } as unknown as CacheParams[0], { appendLine: jest.fn() } as unknown as CacheParams[1], handler as unknown as CacheParams[2]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        findFiles.mockResolvedValue([]);
        openTextDocument.mockResolvedValue({ getText: () => "" });
    });

    it("runs one scan for overlapping rebuild calls", async () => {
        const first = cache.rebuildCache();
        const second = cache.rebuildCache();

        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();

        expect(findFiles).toHaveBeenCalledTimes(1);
        expect(cache.getStats().loaded).toBe(true);
    });

    it("keeps the newer rebuild's result when a superseded scan resolves after it", async () => {
        // Rebuild A parks on the gate before it lists any files.
        const release = handler.armGate();
        const slowRebuild = cache.rebuildCache();
        await flushAsync();

        // What the .uefnproject watcher does: clear, then rebuild. B's scan
        // finds one file; A's, once released, will find none.
        findFiles.mockResolvedValueOnce([{ fsPath: "C:\\Project\\Content\\Scripts\\device.verse" }]);
        cache.clear();
        await cache.rebuildCache();
        expect(cache.getStats().files).toBe(1);

        release();
        await expect(slowRebuild).resolves.toBeUndefined();

        // A resolved last but committed nothing: memory and workspace storage
        // both keep B's file set.
        expect(cache.getStats().files).toBe(1);
        expect(persistedNodeCount()).toBe(1);
    });
});

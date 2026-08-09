import * as vscode from "vscode";
import { ProjectPathCache } from "../ProjectPathCache";

/**
 * Regression tests for issue #255: an unreadable file used to lose everything
 * it had contributed to the cache.
 *
 * invalidateFiles commits a reparse by replacing every node the file owned, and
 * the scanner reported a read failure as an empty declaration list - so a file
 * held open mid-write by UEFN committed as empty and its declarations vanished
 * until something touched the file again.
 *
 * These drive the cache against stub VS Code workspace APIs, so no extension
 * host is needed.
 */
describe("ProjectPathCache.invalidateFiles when a file cannot be read", () => {
    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;

    const CHANGED_FILE = "Scripts/device.verse";

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

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
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

        // The declarations the failing reparse below must not lose.
        await cache.invalidateFiles([CHANGED_FILE]);
        expect(cache.getStats().identifiers).toBe(1);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        openTextDocument.mockResolvedValue({ getText: () => "" });
    });

    it("keeps the file's cached declarations when the read fails", async () => {
        openTextDocument.mockRejectedValue(new Error("EBUSY: resource busy or locked"));

        await cache.invalidateFiles([CHANGED_FILE]);

        expect(cache.getStats().identifiers).toBe(1);
        expect(cache.getStats().files).toBe(1);
        // A later session must not load the loss either.
        expect(persistedNodeCount()).toBe(1);
    });

    it("still drops them when the file parsed and declares nothing", async () => {
        openTextDocument.mockResolvedValue({ getText: () => "# every declaration removed\n" });

        await cache.invalidateFiles([CHANGED_FILE]);

        expect(cache.getStats().identifiers).toBe(0);
        expect(cache.getStats().files).toBe(0);
        expect(persistedNodeCount()).toBe(0);
    });
});

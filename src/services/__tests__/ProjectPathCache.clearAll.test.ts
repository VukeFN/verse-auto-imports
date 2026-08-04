import { ProjectPathCache } from "../ProjectPathCache";

/**
 * Unit tests for ProjectPathCache persistence behavior.
 *
 * These exercise clearAll() against a tiny in-memory Memento stub, so they run
 * under Jest without the VS Code runtime or workspace storage.
 */
describe("ProjectPathCache.clearAll", () => {
    // Storage keys used by ProjectPathCache; kept in sync with its private
    // statics so the test asserts on the actual persisted payload.
    const CACHE_KEY = "projectPathTree";
    const LEGACY_METADATA_KEY = "projectPathTreeMeta";

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

        seed(key: string, value: unknown): void {
            this.store.set(key, value);
        }
    }

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    function createCache(memento: FakeMemento): ProjectPathCache {
        const context = { workspaceState: memento } as unknown as CacheParams[0];
        const outputChannel = { appendLine: jest.fn() } as unknown as CacheParams[1];
        const projectPathHandler = {} as unknown as CacheParams[2];
        return new ProjectPathCache(context, outputChannel, projectPathHandler);
    }

    it("removes the persisted cache and legacy metadata from workspace storage", async () => {
        const memento = new FakeMemento();
        memento.seed(CACHE_KEY, { version: 2, nodes: [] });
        memento.seed(LEGACY_METADATA_KEY, { some: "legacy" });

        await createCache(memento).clearAll();

        expect(memento.get(CACHE_KEY)).toBeUndefined();
        expect(memento.get(LEGACY_METADATA_KEY)).toBeUndefined();
    });

    it("resolves cleanly when nothing is persisted", async () => {
        const memento = new FakeMemento();

        await expect(createCache(memento).clearAll()).resolves.toBeUndefined();

        expect(memento.get(CACHE_KEY)).toBeUndefined();
        expect(memento.get(LEGACY_METADATA_KEY)).toBeUndefined();
    });
});

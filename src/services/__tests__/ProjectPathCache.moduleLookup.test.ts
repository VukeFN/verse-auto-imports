import * as vscode from "vscode";
import { ProjectPathCache } from "../ProjectPathCache";
import { PROJECT_CACHE_VERSION, ProjectPathNode, SerializedProjectPathCache } from "../../types";

/**
 * The cache serves lookups against source paths its scanner recorded relative
 * to the workspace folder, so it has to place them under the project's Content
 * root itself. While that root was read at one fixed depth, a project whose
 * Verse sits under `Plugins/<Name>/Content` had every cached candidate
 * discarded as outside Content, and the converter fell through to a scan that
 * was blind to the same layout.
 */
describe("ProjectPathCache.lookupModuleLocations under a nested plugin Content root", () => {
    const WORKSPACE_ROOT = "C:/Project";
    const ROOT_PLUGIN = "MyGame";
    const CONTENT_ROOT = `${WORKSPACE_ROOT}/Plugins/${ROOT_PLUGIN}/Content`;

    /** Minimal in-memory stand-in for vscode.Memento (workspaceState). */
    class FakeMemento {
        private readonly store: Map<string, unknown> = new Map();

        get<T>(key: string): T | undefined {
            return this.store.get(key) as T | undefined;
        }

        async update(key: string, value: unknown): Promise<void> {
            this.store.set(key, value);
        }
    }

    type CacheParams = ConstructorParameters<typeof ProjectPathCache>;

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    /** Answers `fs.stat` as a directory for exactly these paths. */
    const stubDirectories = (paths: string[]): void => {
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: { fsPath: string }) => {
            if (!paths.includes(uri.fsPath.replace(/\\/g, "/"))) throw new Error("ENOENT");
            return { type: vscode.FileType.Directory };
        });
    };

    /**
     * A cache holding one module declaration, restored from storage so no scan
     * runs. `rootPluginName` is what the project file declares, which is what
     * admits a Content root nested under `Plugins/<name>`.
     */
    const cacheHolding = async (node: ProjectPathNode, rootPluginName: string | null): Promise<ProjectPathCache> => {
        const workspaceState = new FakeMemento();
        const stored: SerializedProjectPathCache = {
            version: PROJECT_CACHE_VERSION,
            projectVersePath: "/mygame@fortnite.com/mygame",
            projectName: "mygame",
            generatedAt: 0,
            nodes: [node],
        };
        await workspaceState.update("projectPathTree", stored);

        const handler = {
            getProjectName: async () => "mygame",
            getProjectVersePath: async () => "/mygame@fortnite.com/mygame",
            getRootPluginName: async () => rootPluginName,
        };

        const cache = new ProjectPathCache(
            { workspaceState } as unknown as CacheParams[0],
            vscode.window.createOutputChannel("test") as unknown as CacheParams[1],
            handler as unknown as CacheParams[2],
        );
        await cache.initialize();
        return cache;
    };

    const declaration = (sourceFile: string): ProjectPathNode => ({
        name: "Inventory",
        fullPath: "Inventory",
        type: "module",
        isPublic: true,
        sourceFile,
    });

    beforeEach(() => {
        setWorkspaceFolders([{ uri: { fsPath: WORKSPACE_ROOT }, name: "Project", index: 0 }]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.fs.stat as jest.Mock).mockReset();
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    it("places a cached declaration under a Content root nested below the workspace folder", async () => {
        stubDirectories([CONTENT_ROOT]);
        const cache = await cacheHolding(declaration(`Plugins/${ROOT_PLUGIN}/Content/Systems/Inventory.verse`), ROOT_PLUGIN);

        expect(await cache.lookupModuleLocations("Inventory")).toEqual([{ location: "/Systems", sourceFile: `Plugins/${ROOT_PLUGIN}/Content/Systems/Inventory.verse` }]);
    });

    it("still places a declaration under a Content directly below the workspace folder", async () => {
        stubDirectories([`${WORKSPACE_ROOT}/Content`]);
        const cache = await cacheHolding(declaration("Content/Systems/Inventory.verse"), ROOT_PLUGIN);

        expect(await cache.lookupModuleLocations("Inventory")).toEqual([{ location: "/Systems", sourceFile: "Content/Systems/Inventory.verse" }]);
    });

    // Only the root plugin's Content answers to bindings.projectVersePath, so a
    // project declaring none has no evidence for a nested root and a
    // declaration under one is not at any location this project can address.
    it("finds no location for a nested declaration when the project declares no root plugin", async () => {
        stubDirectories([CONTENT_ROOT]);
        const cache = await cacheHolding(declaration(`Plugins/${ROOT_PLUGIN}/Content/Systems/Inventory.verse`), null);

        expect(await cache.lookupModuleLocations("Inventory")).toEqual([]);
    });
});

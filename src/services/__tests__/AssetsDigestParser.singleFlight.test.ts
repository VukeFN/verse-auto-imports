import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AssetsDigestParser } from "../AssetsDigestParser";
import { ProjectPathHandler } from "../../project";

/**
 * Regression tests for issue #377: parseAssetsDigest read its TTL before the
 * first await, so every call that arrived while a parse was in flight passed
 * the check and re-read the digest file.
 */
describe("AssetsDigestParser.parseAssetsDigest under concurrent invocation", () => {
    const LOCAL_APP_DATA = path.join("C:", "Users", "tester", "AppData", "Local");
    const DIGEST_PATH = path.join(LOCAL_APP_DATA, "UnrealEditorFortnite", "Saved", "VerseProject", "MyGame", "MyGame-Assets", "Assets.digest.verse");

    const DIGEST_SOURCE = "TestSphere<scoped {/mygame@fortnite.com/mygame}> := class(mesh_component):\n";

    let parser: AssetsDigestParser;
    let readFileSync: jest.SpyInstance;
    let savedLocalAppData: string | undefined;
    /** When set, answers the next project-name lookup instead of "MyGame". */
    let gateNextLookup: (() => Promise<string | null>) | null;

    beforeEach(() => {
        savedLocalAppData = process.env.LOCALAPPDATA;
        process.env.LOCALAPPDATA = LOCAL_APP_DATA;
        gateNextLookup = null;

        jest.spyOn(fs, "existsSync").mockImplementation((target) => String(target) === DIGEST_PATH);
        readFileSync = jest.spyOn(fs, "readFileSync").mockReturnValue(DIGEST_SOURCE);

        const handler = {
            async getProjectName(): Promise<string | null> {
                const gated = gateNextLookup;
                if (gated) {
                    gateNextLookup = null;
                    return gated();
                }
                return "MyGame";
            },
        } as unknown as ProjectPathHandler;
        parser = new AssetsDigestParser(vscode.window.createOutputChannel("test"), handler);
    });

    afterEach(() => {
        process.env.LOCALAPPDATA = savedLocalAppData;
        jest.restoreAllMocks();
    });

    it("reads the digest once for overlapping refresh calls", async () => {
        const first = parser.parseAssetsDigest();
        const second = parser.parseAssetsDigest();

        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();

        expect(readFileSync).toHaveBeenCalledTimes(1);
    });

    it("discards an in-flight parse's names when clearCache overtakes it", async () => {
        // Park the parse inside getProjectName - where getAssetsDigestPath
        // awaits - while the digest watcher's refresh clears the cache.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        gateNextLookup = async () => {
            await gate;
            return "MyGame";
        };

        const overtaken = parser.parseAssetsDigest();
        parser.clearCache();

        // What refreshCache does after its clear: parse immediately. It must
        // run its own read rather than join the overtaken parse.
        const refreshed = parser.parseAssetsDigest();
        release();
        await Promise.all([overtaken, refreshed]);

        expect(readFileSync).toHaveBeenCalledTimes(2);
        expect(parser.getAssetClassNames().has("TestSphere")).toBe(true);

        // The overtaken parse must not have stamped the TTL over the clear:
        // after another clear, a parse still re-reads instead of no-opping.
        parser.clearCache();
        readFileSync.mockClear();
        await parser.parseAssetsDigest();
        expect(readFileSync).toHaveBeenCalledTimes(1);
    });

    it("still serves the TTL cache once a parse has settled", async () => {
        await parser.parseAssetsDigest();
        readFileSync.mockClear();

        await parser.parseAssetsDigest();

        expect(readFileSync).not.toHaveBeenCalled();
    });
});

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PrecompiledDigestLoader } from "../PrecompiledDigestLoader";
import { BUNDLED_DIGEST_NAMES, digestDataFile } from "../digestManifest";

/**
 * Regression tests for issue #377: loadPrecompiledDigests latched `loaded`
 * only after the merge, so overlapping calls each read and merged every digest
 * file into the shared cache.
 */
describe("PrecompiledDigestLoader under concurrent invocation", () => {
    const EXTENSION_PATH = path.join("C:", "extensions", "vukefn.verse-auto-imports");
    const DATA_DIR = path.join(EXTENSION_PATH, "src", "data");

    const payload = JSON.stringify({
        version: "2",
        generatedAt: "2026-01-01",
        sourceFile: "test",
        sourceBuild: "test",
        entries: {
            device: [{ identifier: "device", modulePath: "/Fortnite.com/Devices", type: "class", isPublic: true }],
        },
        moduleIndex: { "/Fortnite.com/Devices": ["device"] },
    });

    let loader: PrecompiledDigestLoader;
    let readFileSync: jest.SpyInstance;

    beforeEach(() => {
        jest.spyOn(fs, "existsSync").mockImplementation((target) => {
            const asString = String(target);
            return asString === DATA_DIR || BUNDLED_DIGEST_NAMES.some((name) => asString === path.join(DATA_DIR, digestDataFile(name)));
        });
        readFileSync = jest.spyOn(fs, "readFileSync").mockReturnValue(payload);

        loader = new PrecompiledDigestLoader({ extensionPath: EXTENSION_PATH } as unknown as vscode.ExtensionContext);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("reads each digest file once for overlapping load calls", async () => {
        const first = loader.loadPrecompiledDigests();
        const second = loader.loadPrecompiledDigests();

        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();

        expect(readFileSync).toHaveBeenCalledTimes(BUNDLED_DIGEST_NAMES.length);
        expect(loader.isLoaded()).toBe(true);
    });

    it("still short-circuits a call after the load has settled", async () => {
        await loader.loadPrecompiledDigests();
        readFileSync.mockClear();

        await loader.loadPrecompiledDigests();

        expect(readFileSync).not.toHaveBeenCalled();
    });
});

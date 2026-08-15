import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DigestParser } from "../DigestParser";
import { DigestEntry } from "../digestParsing";

/**
 * Regression tests for issue #143.
 *
 * Two defects, both in how DigestParser behaved when it could not serve a good
 * answer. It fell back to parsing `src/utils/*.digest.verse`, which
 * `.vscodeignore` keeps out of the `.vsix`, and it latched that unreachable
 * fallback on permanently after one load failure - so a single bad
 * `src/data/*.digest.json` cost the session every lookup while the log claimed
 * a successful fallback. Separately, lookups matched by substring, so `device`
 * answered with every identifier containing it.
 *
 * These drive the real PrecompiledDigestLoader through a mocked `fs`, because
 * both defects were in the load-and-fall-back wiring rather than in parsing.
 */
describe("DigestParser", () => {
    const EXTENSION_PATH = path.join("C:", "extensions", "vukefn.verse-auto-imports");
    const DATA_DIR = path.join(EXTENSION_PATH, "src", "data");

    const entry = (identifier: string, modulePath: string): DigestEntry => ({
        identifier,
        modulePath,
        type: "class",
        isPublic: true,
    });

    /**
     * Identifiers chosen so that one is a strict substring of the others - the
     * shape that produced a 226-entry quick-fix list for `device`.
     */
    const FORTNITE_ENTRIES: Record<string, DigestEntry[]> = {
        device: [entry("device", "/Fortnite.com/Devices")],
        button_device: [entry("button_device", "/Fortnite.com/Devices")],
        trigger_device: [entry("trigger_device", "/Fortnite.com/Devices")],
    };

    /** Whether the data directory and its files can be read this test. */
    let dataReadable: boolean;
    /** The digest files the mocked data directory holds, keyed by file name. */
    let digestFiles: Record<string, Record<string, DigestEntry[]>>;
    let parser: DigestParser;

    const showErrorMessage = vscode.window.showErrorMessage as unknown as jest.Mock;

    const newParser = (withContext = true): DigestParser => {
        const context = { extensionPath: EXTENSION_PATH } as unknown as vscode.ExtensionContext;
        return new DigestParser(vscode.window.createOutputChannel("test"), withContext ? context : undefined);
    };

    beforeEach(() => {
        dataReadable = true;
        digestFiles = { "Fortnite.digest.json": FORTNITE_ENTRIES };
        showErrorMessage.mockClear();

        jest.spyOn(fs, "existsSync").mockImplementation((target) => {
            if (!dataReadable) {
                return false;
            }
            const asString = String(target);
            return asString === DATA_DIR || Object.keys(digestFiles).some((fileName) => asString === path.join(DATA_DIR, fileName));
        });

        jest.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor) =>
            JSON.stringify({
                version: "2",
                generatedAt: "",
                sourceFile: "",
                sourceBuild: "",
                entries: digestFiles[path.basename(String(target))] ?? {},
                moduleIndex: {},
            })) as unknown as typeof fs.readFileSync);

        parser = newParser();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("lookupIdentifier", () => {
        it("returns only the entry bearing the identifier, not every one containing it", async () => {
            const results = await parser.lookupIdentifier("device");

            expect(results.map((result) => result.identifier)).toEqual(["device"]);
        });

        it("returns nothing for a string that is only ever a substring of an identifier", async () => {
            expect(await parser.lookupIdentifier("evice")).toEqual([]);
        });

        it("still resolves an identifier that contains another", async () => {
            const results = await parser.lookupIdentifier("button_device");

            expect(results.map((result) => result.identifier)).toEqual(["button_device"]);
        });

        it("returns nothing for an identifier the digests do not declare", async () => {
            expect(await parser.lookupIdentifier("no_such_identifier")).toEqual([]);
        });
    });

    /**
     * Regression tests for issue #375.
     *
     * An identifier public in more than one module used to resolve to whichever
     * file BUNDLED_DIGEST_NAMES reached first, so the whole SpatialMath surface
     * answered with the deprecated /UnrealEngine.com/Temporary path and the user
     * was never shown that /Verse.org/SpatialMath existed.
     */
    describe("when more than one module declares an identifier", () => {
        beforeEach(() => {
            digestFiles = {
                "UnrealEngine.digest.json": {
                    Distance: [entry("Distance", "/UnrealEngine.com/Temporary/SpatialMath")],
                },
                "Verse.digest.json": {
                    Distance: [entry("Distance", "/Verse.org/SpatialMath")],
                },
            };
        });

        it("returns every declaring module, led by the one the manifest prefers", async () => {
            const results = await parser.lookupIdentifier("Distance");

            expect(results.map((result) => result.modulePath)).toEqual(["/Verse.org/SpatialMath", "/UnrealEngine.com/Temporary/SpatialMath"]);
        });

        it("keeps one entry per module path when a file repeats a declaration", async () => {
            digestFiles["Verse.digest.json"] = {
                Distance: [entry("Distance", "/Verse.org/SpatialMath"), entry("Distance", "/Verse.org/SpatialMath")],
            };

            const results = await parser.lookupIdentifier("Distance");

            expect(results.map((result) => result.modulePath)).toEqual(["/Verse.org/SpatialMath", "/UnrealEngine.com/Temporary/SpatialMath"]);
        });
    });

    describe("when the digest data cannot be read", () => {
        beforeEach(() => {
            dataReadable = false;
        });

        it("tells the user once however many lookups fail", async () => {
            await parser.lookupIdentifier("device");
            await parser.lookupIdentifier("button_device");
            await parser.lookupIdentifier("trigger_device");

            expect(showErrorMessage).toHaveBeenCalledTimes(1);
            expect(showErrorMessage.mock.calls[0][0]).toMatch(/digest data/);
        });

        it("returns an empty result rather than throwing", async () => {
            expect(await parser.lookupIdentifier("device")).toEqual([]);
        });

        it("serves lookups again once the data becomes readable", async () => {
            expect(await parser.lookupIdentifier("device")).toEqual([]);

            dataReadable = true;

            const results = await parser.lookupIdentifier("device");
            expect(results.map((result) => result.identifier)).toEqual(["device"]);
        });

        it("reports nothing loaded", async () => {
            await parser.lookupIdentifier("device");

            expect(parser.getStats()).toEqual({ entries: 0, loaded: false });
        });
    });

    describe("without an ExtensionContext", () => {
        it("serves an empty index without reading the disk or alarming the user", async () => {
            const contextless = newParser(false);

            expect(await contextless.lookupIdentifier("device")).toEqual([]);
            expect(await contextless.getDigestIndex()).toEqual(new Map());
            expect(showErrorMessage).not.toHaveBeenCalled();
            expect(contextless.getStats()).toEqual({ entries: 0, loaded: false });
        });
    });

    describe("clearCache", () => {
        it("makes the next lookup re-read the data", async () => {
            await parser.lookupIdentifier("device");
            const readsBefore = (fs.readFileSync as unknown as jest.Mock).mock.calls.length;

            parser.clearCache();
            await parser.lookupIdentifier("device");

            expect((fs.readFileSync as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(readsBefore);
        });
    });
});

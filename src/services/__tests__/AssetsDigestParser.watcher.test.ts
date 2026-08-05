import * as fs from "fs";
import * as vscode from "vscode";
import { AssetsDigestParser } from "../AssetsDigestParser";
import { ProjectPathHandler } from "../../project";

/**
 * Regression tests for issue #131: the Assets.digest.verse watcher only cleared
 * the cache, and nothing refilled it. The single consumer,
 * ImportSuggestionExtractor, reads through the synchronous isAssetClassName(),
 * so after the first watcher event the parser knew no asset names for the rest
 * of the session and import paths silently degraded.
 *
 * These drive the real watcher wiring through the vscode mock, because the
 * defect was in the wiring rather than in the parsing.
 */
describe("AssetsDigestParser file watchers", () => {
    /** The subset of the mock watcher these tests drive. */
    interface FakeWatcher {
        fireChange(fsPath: string): void;
        fireCreate(fsPath: string): void;
        fireDelete(fsPath: string): void;
        disposed: boolean;
    }

    const DIGEST_PATH = "C:\\LocalAppData\\UnrealEditorFortnite\\Saved\\VerseProject\\MyGame\\MyGame-Assets\\Assets.digest.verse";
    const FIRST_DIGEST = "OldAsset := class(material):";
    const SECOND_DIGEST = "NewAsset := class(material):";

    /** Current digest content, or null when the file does not exist. */
    let digestContent: string | null;
    /** Paths the parser has read, in order, so a re-resolve can be asserted. */
    let readPaths: string[];
    let projectName: string;
    let parser: AssetsDigestParser;
    let watchers: FakeWatcher[];
    let watcherDisposable: vscode.Disposable;

    const createFileSystemWatcher = vscode.workspace.createFileSystemWatcher as unknown as jest.Mock;

    /** Runs the debounced refresh and the promise chain it starts. */
    const runScheduledRefresh = async (): Promise<void> => {
        await jest.advanceTimersByTimeAsync(1000);
    };

    beforeEach(() => {
        jest.useFakeTimers();
        digestContent = FIRST_DIGEST;
        readPaths = [];
        projectName = "MyGame";

        jest.spyOn(fs, "existsSync").mockImplementation((target) => digestContent !== null && String(target).endsWith("Assets.digest.verse"));
        jest.spyOn(fs, "readFileSync").mockImplementation(((target: string): string => {
            readPaths.push(String(target));
            return digestContent ?? "";
        }) as unknown as typeof fs.readFileSync);

        const projectPathHandler = {
            getProjectName: jest.fn().mockImplementation(async () => projectName),
        } as unknown as ProjectPathHandler;

        parser = new AssetsDigestParser(vscode.window.createOutputChannel("test"), projectPathHandler);

        createFileSystemWatcher.mockClear();
        watcherDisposable = parser.setupFileWatcher();
        watchers = createFileSystemWatcher.mock.results.map((result) => result.value as FakeWatcher);
    });

    afterEach(() => {
        watcherDisposable.dispose();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    /** The Assets.digest.verse watcher, created first by setupFileWatcher. */
    const digestWatcher = (): FakeWatcher => watchers[0];

    /** The .uefnproject watcher, created second. */
    const projectWatcher = (): FakeWatcher => watchers[1];

    it("refills the cache after the digest changes", async () => {
        await parser.ensureCachePopulated();
        expect(parser.isAssetClassName("OldAsset")).toBe(true);

        digestContent = SECOND_DIGEST;
        digestWatcher().fireChange(DIGEST_PATH);
        await runScheduledRefresh();

        expect(parser.isAssetClassName("NewAsset")).toBe(true);
        expect(parser.isAssetClassName("OldAsset")).toBe(false);
    });

    it("parses the digest when UEFN creates it after activation", async () => {
        digestContent = null;
        await parser.ensureCachePopulated();
        expect(parser.getAssetClassNames().size).toBe(0);

        digestContent = FIRST_DIGEST;
        digestWatcher().fireCreate(DIGEST_PATH);
        await runScheduledRefresh();

        expect(parser.isAssetClassName("OldAsset")).toBe(true);
    });

    it("empties the cache when the digest is deleted", async () => {
        await parser.ensureCachePopulated();
        expect(parser.isAssetClassName("OldAsset")).toBe(true);

        digestContent = null;
        digestWatcher().fireDelete(DIGEST_PATH);
        await runScheduledRefresh();

        expect(parser.getAssetClassNames().size).toBe(0);
    });

    it("re-resolves the digest path for the renamed project", async () => {
        await parser.ensureCachePopulated();
        expect(parser.isAssetClassName("OldAsset")).toBe(true);

        // The digest path is derived from the project name, so a rename has to
        // send the parser to a different file, not just re-read the old one.
        projectName = "RenamedGame";
        digestContent = SECOND_DIGEST;
        readPaths = [];
        projectWatcher().fireChange("C:\\Projects\\RenamedGame\\RenamedGame.uefnproject");
        await runScheduledRefresh();

        expect(readPaths).toEqual([expect.stringContaining("RenamedGame")]);
        expect(parser.isAssetClassName("NewAsset")).toBe(true);
        expect(parser.isAssetClassName("OldAsset")).toBe(false);
    });

    it("re-parses for a .uefnproject file that appears after activation", async () => {
        digestContent = null;
        await parser.ensureCachePopulated();

        digestContent = FIRST_DIGEST;
        projectWatcher().fireCreate("C:\\Projects\\MyGame\\MyGame.uefnproject");
        await runScheduledRefresh();

        expect(parser.isAssetClassName("OldAsset")).toBe(true);
    });

    it("coalesces a burst of events into a single re-parse", async () => {
        await parser.ensureCachePopulated();
        readPaths = [];

        digestWatcher().fireChange(DIGEST_PATH);
        digestWatcher().fireChange(DIGEST_PATH);
        digestWatcher().fireChange(DIGEST_PATH);
        await runScheduledRefresh();

        expect(readPaths).toHaveLength(1);
    });

    it("drops a queued refresh when the watchers are disposed", async () => {
        await parser.ensureCachePopulated();
        readPaths = [];

        digestWatcher().fireChange(DIGEST_PATH);
        watcherDisposable.dispose();
        await runScheduledRefresh();

        expect(readPaths).toHaveLength(0);
    });
});

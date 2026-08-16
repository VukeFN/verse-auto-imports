import * as fs from "fs";
import * as vscode from "vscode";
import { ProjectPathHandler } from "../ProjectPathHandler";

/**
 * Regression tests for issue #377: findAndParseProjectFile cached only a
 * finished success, so overlapping calls for the same scope each redid the
 * folder scan and the parent walk, and a search running across a `.uefnproject`
 * change could cache the pre-change parse over the fresh one.
 */
describe("ProjectPathHandler.findAndParseProjectFile under concurrent invocation", () => {
    const ROOT = "/workspace/game";
    const PROJECT_PATH = `${ROOT}/Project.uefnproject`;

    const PROJECT = {
        title: "MyGame",
        bindings: { projectVersePath: "/mygame@fortnite.com/mygame" },
    };

    /** Project files read, in order, so a cache hit can be told from a miss. */
    let reads: string[];
    let handler: ProjectPathHandler;

    const forwardSlashed = (fsPath: string) => fsPath.replace(/\\/g, "/").replace(/\/+$/, "");

    beforeEach(() => {
        reads = [];

        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(ROOT), name: "game", index: 0 }];

        (vscode.workspace.findFiles as jest.Mock).mockImplementation(async (pattern: { base: { uri?: { fsPath: string }; fsPath?: string } }) => {
            const base = pattern.base.uri ?? (pattern.base as { fsPath: string });
            return forwardSlashed(base.fsPath) === ROOT ? [vscode.Uri.file(PROJECT_PATH)] : [];
        });

        jest.spyOn(fs, "readFileSync").mockImplementation(((target: string): string => {
            reads.push(forwardSlashed(String(target)));
            return JSON.stringify(PROJECT);
        }) as unknown as typeof fs.readFileSync);

        handler = new ProjectPathHandler(vscode.window.createOutputChannel("test"));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        (vscode.workspace.findFiles as jest.Mock).mockReset().mockResolvedValue([]);
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    it("shares one search among overlapping calls for the same scope", async () => {
        const [first, second] = await Promise.all([handler.findAndParseProjectFile(), handler.findAndParseProjectFile()]);

        expect(first?.title).toBe("MyGame");
        expect(second?.title).toBe("MyGame");
        expect(reads).toHaveLength(1);
    });

    it("does not cache a search that a clearCache overtook", async () => {
        // Park the search on its folder listing while the cache is cleared
        // underneath it - what the .uefnproject watcher does on a change.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (vscode.workspace.findFiles as jest.Mock).mockImplementationOnce(async () => {
            await gate;
            return [vscode.Uri.file(PROJECT_PATH)];
        });

        const pending = handler.findAndParseProjectFile();
        handler.clearCache();
        release();
        await pending;

        // The overtaken search's parse predates the change, so the next call
        // must search again rather than answer from it.
        reads = [];
        await handler.findAndParseProjectFile();
        expect(reads).toHaveLength(1);
    });
});

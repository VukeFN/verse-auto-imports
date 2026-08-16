import * as vscode from "vscode";
import { contentRootCandidates, findContentRoot } from "../contentRoot";

/**
 * The candidate list is the whole of the depth rule, so it is pinned here
 * rather than only through the scans that consume it: order decides which root
 * a project with more than one wins, and what is left out decides what the
 * scans refuse to look under at all.
 */
describe("contentRootCandidates", () => {
    const WORKSPACE_ROOT = "C:/Project";

    it("offers the workspace folder itself when that is the Content folder", () => {
        // UEFN's generated workspace opens here, so this is the common case and
        // the one that must cost no filesystem check.
        expect(contentRootCandidates(`${WORKSPACE_ROOT}/Plugins/MyGame/Content`, "MyGame")).toEqual([""]);
    });

    it("offers the shallowest root first, so a Content below it stays a folder module", () => {
        expect(contentRootCandidates(WORKSPACE_ROOT, "MyGame")).toEqual(["Content", "Plugins/MyGame/Content"]);
    });

    // Only the root plugin's Content answers to bindings.projectVersePath, so a
    // project declaring none offers no evidence for a nested root.
    it("offers no nested root when the project declares no root plugin", () => {
        expect(contentRootCandidates(WORKSPACE_ROOT, null)).toEqual(["Content"]);
    });

    // UEFN writes the name and creates the directory from one value, so these
    // are malformed project files rather than layouts. Joining one anyway would
    // resolve its segments and put the root outside the workspace folder, where
    // the visibility writer would go on to create its definitions file.
    it.each(["../../Elsewhere", "..", ".", "Nested/Plugin", "Nested\\Plugin", "C:/Elsewhere"])("offers no nested root for the plugin name %p", (rootPluginName) => {
        expect(contentRootCandidates(WORKSPACE_ROOT, rootPluginName)).toEqual(["Content"]);
    });

    // The project file's own directory anchors Plugins/<root>/Content, so a
    // workspace opened above the project root - at Plugins - still reaches it.
    it("composes the nested root from the project file's directory", () => {
        expect(contentRootCandidates(`${WORKSPACE_ROOT}/Plugins`, "MyGame", WORKSPACE_ROOT)).toEqual(["Content", "MyGame/Content", "Plugins/MyGame/Content"]);
    });

    it("offers the composed root once when the project sits at the workspace folder", () => {
        expect(contentRootCandidates(WORKSPACE_ROOT, "MyGame", WORKSPACE_ROOT)).toEqual(["Content", "Plugins/MyGame/Content"]);
    });

    // The parent-walk case: the project file sits above the workspace folder
    // and its Content root outside it, where no glob rooted in the folder
    // would reach and the visibility writer must not create files.
    it("drops a composed root that escapes the workspace folder", () => {
        expect(contentRootCandidates(`${WORKSPACE_ROOT}/Plugins/MyGame/Verse`, "MyGame", WORKSPACE_ROOT)).toEqual(["Content", "Plugins/MyGame/Content"]);
    });
});

/**
 * Issue's entry point: with the workspace opened at `<project>/Plugins`, the
 * document-relative placement accepted `<ws>/<Root>/Content` while this
 * returned null, so the scan phases and the visibility writer never globbed.
 */
describe("findContentRoot", () => {
    const statAcceptingDirectory = (fsPath: string) => async (uri: { fsPath: string }) => {
        if (uri.fsPath.replace(/\\/g, "/") === fsPath) {
            return { type: vscode.FileType.Directory };
        }
        throw new Error("ENOENT");
    };

    afterEach(() => {
        (vscode.workspace.fs.stat as jest.Mock).mockReset().mockRejectedValue(new Error("ENOENT"));
    });

    it("finds the root plugin's Content from a workspace opened at Plugins", async () => {
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation(statAcceptingDirectory("C:/Project/Plugins/MyGame/Content"));

        const root = await findContentRoot({ uri: vscode.Uri.file("C:/Project/Plugins") }, "MyGame", "C:/Project");

        expect(root?.fsPath.replace(/\\/g, "/")).toBe("C:/Project/Plugins/MyGame/Content");
    });

    it("still answers null when the composed root does not exist on disk", async () => {
        const root = await findContentRoot({ uri: vscode.Uri.file("C:/Project/Plugins") }, "MyGame", "C:/Project");

        expect(root).toBeNull();
    });
});

// The stat behind every other candidate is case-insensitive on Windows, so
// this test used to be the one byte-exact comparison in the resolver: a
// workspace opened at an on-disk `content` got the "Content" candidate,
// statted `content/Content`, and found nothing.
describe("contentRootCandidates under the platform's case rule", () => {
    const realPlatform = process.platform;
    const setPlatform = (platform: string): void => {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
    };

    afterEach(() => setPlatform(realPlatform));

    it("offers the folder itself for an on-disk `content`, where the filesystem folds case", () => {
        setPlatform("win32");

        expect(contentRootCandidates("C:/Project/content", null)).toEqual([""]);
    });

    it("keeps the spellings apart where the filesystem is byte-exact", () => {
        setPlatform("linux");

        expect(contentRootCandidates("/repo/content", null)).toEqual(["Content"]);
    });
});

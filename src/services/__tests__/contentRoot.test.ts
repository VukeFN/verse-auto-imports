import { contentRootCandidates } from "../contentRoot";

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
});

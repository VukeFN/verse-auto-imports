import * as assert from "assert";
import * as vscode from "vscode";
import { WorkspaceSettings, openFixture, runOptimizeImports } from "./helpers";

describe("import styles matrix (playbook T6)", () => {
    const settings = new WorkspaceSettings();
    let document: vscode.TextDocument;

    before(async () => {
        await settings.set("general.autoImport", false);
        document = await openFixture("t6_styles.verse");
    });

    after(async () => {
        await settings.restoreAll();
    });

    /**
     * Where the import statement naming `fragment` sits, which is what every
     * assertion below is really asking about.
     *
     * Import lines only. Matching any line that merely contains the fragment
     * found the fixture's own header comment, which names `Gadgets.Tools` in
     * prose to say which import is the local one: that comment sits above the
     * block, so `digestFirst` read as violated while the output was correctly
     * grouped. The collision was invisible until the header stopped being
     * pushed below the imports, and any future fixture whose prose names a
     * path would hit it again.
     *
     * Covers the braced and dotted styles, both of which this suite flips
     * between. Not the indented `using:` pair, whose path is on the next line -
     * nothing here writes one, and a test that needs it should locate it
     * deliberately rather than lean on a substring match.
     */
    function importLineIndex(text: string, fragment: string): number {
        return text.split("\n").findIndex((line) => line.startsWith("using") && line.includes(fragment));
    }

    it("importSyntax dot rewrites the block; flipping back restores curly", async () => {
        await settings.set("behavior.importSyntax", "dot");
        let text = await runOptimizeImports(document);
        assert.ok(/^using\. \/Verse\.org\/Simulation$/m.test(text), `expected dot syntax, got:\n${text}`);
        assert.ok(!text.includes("using { /Verse.org/Simulation }"), "curly form must be gone after the dot rewrite");

        await settings.set("behavior.importSyntax", "curly");
        text = await runOptimizeImports(document);
        assert.ok(text.includes("using { /Verse.org/Simulation }"), `expected curly syntax back, got:\n${text}`);
        assert.ok(!/^using\./m.test(text), "dot form must be gone after flipping back");
    });

    it("importGrouping digestFirst puts digest imports before local ones; localFirst reverses", async () => {
        await settings.set("behavior.importGrouping", "digestFirst");
        let text = await runOptimizeImports(document);
        let digestIndex = importLineIndex(text, "/Fortnite.com/Devices");
        let localIndex = importLineIndex(text, "Gadgets.Tools");
        assert.ok(digestIndex !== -1 && localIndex !== -1, `imports missing after optimize:\n${text}`);
        assert.ok(digestIndex < localIndex, `digestFirst violated:\n${text}`);

        await settings.set("behavior.importGrouping", "localFirst");
        text = await runOptimizeImports(document);
        digestIndex = importLineIndex(text, "/Fortnite.com/Devices");
        localIndex = importLineIndex(text, "Gadgets.Tools");
        assert.ok(digestIndex !== -1 && localIndex !== -1, `imports missing after optimize:\n${text}`);
        assert.ok(localIndex < digestIndex, `localFirst violated:\n${text}`);

        await settings.set("behavior.importGrouping", "none");
    });

    it("sortImportsAlphabetically orders the block", async () => {
        await settings.set("behavior.sortImportsAlphabetically", true);
        const text = await runOptimizeImports(document);
        const devices = importLineIndex(text, "/Fortnite.com/Devices");
        const simulation = importLineIndex(text, "/Verse.org/Simulation");
        assert.ok(devices !== -1 && simulation !== -1, `imports missing after optimize:\n${text}`);
        assert.ok(devices < simulation, `alphabetical sort violated (/Fortnite.com/Devices must precede /Verse.org/Simulation):\n${text}`);
    });

    it("emptyLinesAfterImports is honored after optimize", async () => {
        await settings.set("behavior.emptyLinesAfterImports", 2);

        // The spacing pass runs on save, and Optimize only saves a dirty
        // document; after the previous subtests the block is already organized
        // so the rewrite itself is a no-op. Dirty the document the way a real
        // edit session would before optimizing.
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(document.lineCount, 0), "\n# spacing probe\n");
        assert.ok(await vscode.workspace.applyEdit(edit), "probe edit failed");

        const text = await runOptimizeImports(document);
        const lines = text.split("\n");

        let lastImport = -1;
        lines.forEach((line, index) => {
            if (line.startsWith("using")) {
                lastImport = index;
            }
        });
        assert.ok(lastImport !== -1, `no import block found:\n${text}`);

        let blanks = 0;
        let cursor = lastImport + 1;
        while (cursor < lines.length && lines[cursor].trim() === "") {
            blanks++;
            cursor++;
        }
        assert.strictEqual(blanks, 2, `expected exactly 2 blank lines after the import block:\n${text}`);
    });
});

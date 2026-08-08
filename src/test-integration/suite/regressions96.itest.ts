import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { DiagnosticInjector, WorkspaceSettings, assertNoDocumentChange, contentRoot, corpusMessage, docText, openFixture, sleep, waitForDocumentChange } from "./helpers";

/**
 * Long enough for the fixture debounce (100ms) to elapse and for the extension
 * to have edited the document, if it were going to.
 */
const PAST_DEBOUNCE_MS = 1500;

const IMPORT = "using { /Fortnite.com/Devices }";

function fixtureUri(fileName: string): vscode.Uri {
    return vscode.Uri.file(path.join(contentRoot(), fileName));
}

/**
 * Whether the user has the file open, which is what the openFiles scope means.
 * Deliberately not vscode.workspace.textDocuments: ProjectPathScanner opens
 * every .verse file in the project to build the path cache, so that list holds
 * the whole project and would make this assertion vacuous.
 */
function hasTab(uri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()));
}

/**
 * The document text as the extension would have left it. Opening the file here
 * is after the fact - the debounce window has already elapsed - and returns the
 * same instance the extension edited, if it edited one.
 */
async function textAfterTheFact(uri: vscode.Uri): Promise<string> {
    return docText(await vscode.workspace.openTextDocument(uri));
}

describe("auto-import scope (issue #96)", () => {
    let injector: DiagnosticInjector;
    let settings: WorkspaceSettings;

    beforeEach(() => {
        injector = new DiagnosticInjector("verse-itest-scope");
        settings = new WorkspaceSettings();
    });

    afterEach(async () => {
        injector.dispose();
        await settings.restoreAll();
    });

    it("activeFile leaves an open but unfocused document alone, and still imports the focused one", async () => {
        const background = await openFixture("r96_background.verse");
        // Opened second, so it holds focus and background does not.
        const foreground = await openFixture("r96_foreground.verse");
        await settings.set("general.autoImportScope", "activeFile");
        await sleep(300);

        injector.inject(background, [corpusMessage("unknown-with-suggestion-class-context")], "button_device");
        await assertNoDocumentChange(background, PAST_DEBOUNCE_MS);

        // The positive half: the gate must bound auto-import, not switch it
        // off. Without this a gate that rejected everything would pass.
        injector.inject(foreground, [corpusMessage("unknown-with-suggestion-class-context")], "button_device");
        await waitForDocumentChange(foreground, (text) => text.includes(IMPORT), "auto-import of the focused document under activeFile");
    });

    it("openFiles still imports into an open but unfocused document", async () => {
        const target = await openFixture("r96_open_unfocused.verse");
        // Opened second, so target is open in a tab without holding focus.
        await openFixture("r96_foreground.verse");
        await settings.set("general.autoImportScope", "openFiles");
        await sleep(300);
        assert.notStrictEqual(vscode.window.activeTextEditor?.document.uri.toString(), target.uri.toString(), "target must be unfocused, or this would pass through activeUri instead of the tab list");

        injector.inject(target, [corpusMessage("unknown-with-suggestion-class-context")], "button_device");

        // The only test that exercises a positive tab-list match. If a tab uri
        // ever stopped matching the uri diagnostics arrive on, openFiles would
        // silently degrade to never importing and every other case here would
        // still pass: two of them assert a negative, and the third matches
        // through activeUri.
        await waitForDocumentChange(target, (text) => text.includes(IMPORT), "auto-import of the open but unfocused document under openFiles");
    });

    it("openFiles does not edit a file the user never opened", async () => {
        await settings.set("general.autoImportScope", "openFiles");
        await sleep(300);
        const uri = fixtureUri("r96_never_opened.verse");
        assert.strictEqual(hasTab(uri), false, "fixture must be untabbed for this test to mean anything");

        // Diagnostics arrive on the uri with no document behind it, the way the
        // Verse LSP publishes them project-wide.
        injector.injectUri(uri, [corpusMessage("unknown-with-suggestion-class-context")]);
        await sleep(PAST_DEBOUNCE_MS);

        assert.ok(!(await textAfterTheFact(uri)).includes(IMPORT), "openFiles must not auto-import a file with no tab open");
    });

    it("allFiles does edit a file the user never opened", async () => {
        // The control for the test above. It pins the default behavior the
        // ticket keeps, and it is what makes that assertion detect the defect:
        // with the scope gate removed, both tests see this outcome.
        await settings.set("general.autoImportScope", "allFiles");
        await sleep(300);
        const uri = fixtureUri("r96_never_opened_control.verse");
        assert.strictEqual(hasTab(uri), false, "fixture must be untabbed");

        injector.injectUri(uri, [corpusMessage("unknown-with-suggestion-class-context")]);
        await sleep(PAST_DEBOUNCE_MS);

        assert.ok((await textAfterTheFact(uri)).includes(IMPORT), "allFiles must still auto-import project-wide, as it does today");
    });
});

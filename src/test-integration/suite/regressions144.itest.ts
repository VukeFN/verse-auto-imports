import * as assert from "assert";
import * as vscode from "vscode";
import { docText, openFixture, sleep } from "./helpers";

/**
 * Regression for #144. The import-spacing pass used to run on
 * onDidSaveTextDocument and apply a WorkspaceEdit, so a file whose import block
 * did not already carry the configured blank lines was edited after its own
 * save had completed - the tab went straight back to dirty and only a second
 * save converged.
 *
 * The unit tests pin the participant's contract; this pins the symptom the user
 * reported, which is only observable with a real editor doing a real save.
 */
describe("issue #144: saving must not re-dirty the document", () => {
    /** Rewrites the whole document and saves, so the fixture survives the run. */
    async function restore(document: vscode.TextDocument, text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        const end = document.lineAt(document.lineCount - 1).range.end;
        edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
    }

    it("applies the import spacing as part of the save and leaves the tab clean", async () => {
        const document = await openFixture("r144_save_spacing.verse");
        const original = document.getText();

        try {
            // Dirty the document away from the imports so the save actually
            // runs; a clean document does not go through the save at all.
            const probe = new vscode.WorkspaceEdit();
            probe.insert(document.uri, new vscode.Position(document.lineCount, 0), "\n# save probe\n");
            assert.ok(await vscode.workspace.applyEdit(probe), "probe edit failed");

            assert.ok(await document.save(), "save failed");
            // The pre-fix edit landed just after the save resolved, so the
            // dirty assertion below needs to give it the chance to.
            await sleep(500);

            assert.strictEqual(document.isDirty, false, "the document must not be modified again by its own save");
            assert.ok(docText(document).includes("using { /Fortnite.com/Devices }\n\nr144_save_spacing"), `the blank line after the import block is missing, got:\n${docText(document)}`);
        } finally {
            await restore(document, original);
        }
    });
});

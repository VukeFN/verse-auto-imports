import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { EXTENSION_ID, contentRoot } from "./helpers";

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

describe("extension activation", () => {
    it("activates via onLanguage:verse when a .verse file opens", async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} not found in the test host`);

        const probePath = path.join(contentRoot(), "activation_probe.verse");
        const document = await vscode.workspace.openTextDocument(probePath);

        // Nothing else in the test host registers the language id, so this
        // asserts the manifest's own `languages` contribution; without it the
        // activation event below can never fire.
        assert.strictEqual(document.languageId, "verse", "expected .verse files to get the verse language id");

        await waitFor(() => extension.isActive, 15000, "extension activation");
    });

    it("activates even though the project's Assets.digest.verse cannot exist", async () => {
        // The fixture .uefnproject title is VerseAutoImportsIntegrationHarness,
        // so the %LOCALAPPDATA% UnrealEditorFortnite digest path resolves to a
        // directory no UEFN install has. Activation must have degraded
        // gracefully; auto-import still working is asserted by the auto-import
        // suite against the same workspace.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} not found in the test host`);
        assert.strictEqual(extension.isActive, true, "extension should be active despite the missing assets digest");
    });
});

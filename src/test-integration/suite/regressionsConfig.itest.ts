import * as assert from "assert";
import * as vscode from "vscode";
import { DiagnosticInjector, assertNoDocumentChange, corpusMessage, countOccurrences, docText, openFixture, sleep, waitForDocumentChange } from "./helpers";

/** The debounce the fixture workspace configures; restored after each test. */
const FIXTURE_DEBOUNCE_MS = 100;

/**
 * Writes a workspace-level setting and gives the extension's
 * onDidChangeConfiguration listener time to apply the new debounce before
 * diagnostics are injected.
 */
async function setWorkspaceSetting(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration("verseAutoImports").update(key, value, vscode.ConfigurationTarget.Workspace);
    await sleep(300);
}

describe("configuration resolution regressions (issues #76/#77)", () => {
    let injector: DiagnosticInjector;

    beforeEach(() => {
        injector = new DiagnosticInjector("verse-itest-config");
    });

    afterEach(async () => {
        injector.dispose();
        // Restore the fixture debounce explicitly (plain undefined would drop
        // the fixture's own workspace value) and clear any legacy override.
        await setWorkspaceSetting("general.autoImportDebounceDelay", FIXTURE_DEBOUNCE_MS);
        await setWorkspaceSetting("general.diagnosticDelay", undefined);
        await setWorkspaceSetting("behavior.ambiguousImports", undefined);
    });

    it("#77: a configured behavior.ambiguousImports mapping drives auto-import for a bare unknown identifier", async () => {
        await setWorkspaceSetting("behavior.ambiguousImports", { vector3: "/UnrealEngine.com/Temporary/SpatialMath" });
        const document = await openFixture("r77_ambiguous_mapping.verse");
        injector.inject(document, [corpusMessage("unknown-identifier-bare-ambiguous")], "vector3");

        await waitForDocumentChange(document, (text) => text.includes("using { /UnrealEngine.com/Temporary/SpatialMath }"), "auto-import of the mapped SpatialMath path");
        await sleep(500);

        assert.strictEqual(countOccurrences(docText(document), "using { /UnrealEngine.com/Temporary/SpatialMath }"), 1, "mapped import must be inserted exactly once");
    });

    it("#76: autoImportDebounceDelay governs the debounce when diagnosticDelay is unset", async () => {
        await setWorkspaceSetting("general.autoImportDebounceDelay", 3000);
        const document = await openFixture("r76_debounce.verse");
        injector.inject(document, [corpusMessage("unknown-with-suggestion-class-context")], "button_device");

        // With the fix the effective debounce is 3000ms, so nothing may land
        // this early. Before the fix the deprecated key's registered default
        // (1000ms) won and the import arrived inside this window.
        await assertNoDocumentChange(document, 1500);

        // The import must still land once the configured debounce elapses.
        await waitForDocumentChange(document, (text) => text.includes("using { /Fortnite.com/Devices }"), "auto-import after the 3000ms debounce", 4000);
    });

    it("#76: an explicit legacy diagnosticDelay is honored while the new key is unset", async () => {
        await setWorkspaceSetting("general.autoImportDebounceDelay", undefined);
        await setWorkspaceSetting("general.diagnosticDelay", FIXTURE_DEBOUNCE_MS);
        const document = await openFixture("r76_legacy_delay.verse");
        injector.inject(document, [corpusMessage("unknown-with-suggestion-module-context")], "editable");

        // Without legacy support the effective debounce would fall back to the
        // registered 3000ms default and this wait would time out.
        await waitForDocumentChange(document, (text) => text.includes("using { /Verse.org/Simulation }"), "auto-import under the legacy delay", 2000);
        await sleep(500);

        assert.strictEqual(countOccurrences(docText(document), "using { /Verse.org/Simulation }"), 1, "import must be inserted exactly once");
    });
});

import * as assert from "assert";
import * as vscode from "vscode";
import { openFixture, restoreSetting, sleep, snapshotSetting } from "./helpers";

const AUTO_IMPORT = "general.autoImport";

describe("commands and snooze (playbook T7/T8)", () => {
    before(async () => {
        // Guarantees activation so all commands are registered.
        await openFixture("activation_probe.verse");
    });

    it("T7/T8: every contributed command is registered", async () => {
        const registered = await vscode.commands.getCommands(true);
        const expected = [
            "verseAutoImports.showStatusMenu",
            "verseAutoImports.optimizeImports",
            "verseAutoImports.addSingleImport",
            "verseAutoImports.toggleAutoImport",
            "verseAutoImports.togglePreserveLocations",
            "verseAutoImports.toggleImportSyntax",
            "verseAutoImports.toggleDigestFiles",
            "verseAutoImports.toggleFullPathCodeLens",
            "verseAutoImports.snoozeAutoImport",
            "verseAutoImports.cancelSnooze",
            "verseAutoImports.convertToFullPath",
            "verseAutoImports.convertAllToFullPath",
            "verseAutoImports.convertToRelativePath",
            "verseAutoImports.convertAllToRelativePath",
            "verseAutoImports.exportDebugLogs",
            "verseAutoImports.captureDiagnosticsCorpus",
            "verseAutoImports.rebuildPathCache",
            "verseAutoImports.clearPathCache",
            "verseAutoImports.showCacheStatus",
        ];
        for (const commandId of expected) {
            assert.ok(registered.includes(commandId), `command ${commandId} is not registered`);
        }
    });

    it("T7: rebuild path cache discovers the fixture project outside the workspace folders", async () => {
        // The fixture .uefnproject sits in Project/, above the opened
        // Project/Content folder - the UEFN multi-root shape - so a loaded
        // cache carrying the project's name pins the whole discovery chain:
        // the parent walk, the parse, and the scan keyed on the identity.
        const stats = await vscode.commands.executeCommand<{ loaded: boolean; files: number; projectName: string | null }>("verseAutoImports.rebuildPathCache");

        assert.ok(stats, "rebuildPathCache returned no stats - is the cache disabled in the harness?");
        assert.strictEqual(stats.loaded, true, "the rebuilt cache reports itself unloaded");
        assert.strictEqual(stats.projectName, "VerseAutoImportsIntegrationHarness", "the cache does not carry the fixture project's name");
        assert.ok(stats.files > 0, "the scan indexed no files from the fixture workspace");
    });

    // Regression (#132): the snooze used to write general.autoImport: false
    // into global user settings, so a reload during the snooze left auto-import
    // off permanently. Snooze state is now in-memory and settings stay clean.
    it("T8: snooze leaves user settings untouched; re-snoozing stays coherent; cancel is clean", async () => {
        // Read about the open file: general.autoImport is resource-scoped, and
        // the write path picks its level from whichever already holds an
        // override, so no single level is the one to watch.
        const resource = vscode.window.activeTextEditor?.document.uri;
        const before = snapshotSetting(AUTO_IMPORT, resource);
        const assertUnchanged = (message: string): void => {
            assert.deepStrictEqual(snapshotSetting(AUTO_IMPORT, resource), before, message);
        };
        try {
            await vscode.commands.executeCommand("verseAutoImports.snoozeAutoImport");
            await sleep(300);
            assertUnchanged("snooze must not write general.autoImport at any level");

            // Re-invoking while already snoozed must not corrupt the state
            // (single timer per the 0.6.x snooze fix).
            await vscode.commands.executeCommand("verseAutoImports.snoozeAutoImport");
            await sleep(300);
            assertUnchanged("re-snoozing must not write general.autoImport either");

            await vscode.commands.executeCommand("verseAutoImports.cancelSnooze");
            await sleep(300);
            assertUnchanged("cancelling must not write general.autoImport either");
        } finally {
            // Never leak a snoozed state, or a stray override at any level,
            // into later suites: the fixture workspace is reused across the run.
            await vscode.commands.executeCommand("verseAutoImports.cancelSnooze");
            await restoreSetting(AUTO_IMPORT, before, resource);
        }
    });
});

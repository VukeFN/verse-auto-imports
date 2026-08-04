import * as assert from "assert";
import * as vscode from "vscode";
import { openFixture, sleep } from "./helpers";

function globalAutoImport(): boolean | undefined {
    return vscode.workspace.getConfiguration("verseAutoImports").inspect<boolean>("general.autoImport")?.globalValue;
}

async function waitForGlobalAutoImport(expected: boolean, timeoutMs: number = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (globalAutoImport() === expected) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`general.autoImport globalValue did not become ${expected} within ${timeoutMs}ms (currently ${globalAutoImport()})`);
}

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

    it("T7: rebuild path cache completes against the fixture workspace", async () => {
        // Resolving without throwing is the assertion: the cache scan must
        // cope with the multi-root fixture layout (Content plus digest roots).
        await vscode.commands.executeCommand("verseAutoImports.rebuildPathCache");
    });

    it("T8: snooze disables auto-import globally; re-snoozing stays coherent; cancel restores", async () => {
        try {
            await vscode.commands.executeCommand("verseAutoImports.snoozeAutoImport");
            await waitForGlobalAutoImport(false);

            // Re-invoking while already snoozed must not corrupt the state
            // (single timer per the 0.6.x snooze fix); the setting stays off.
            await vscode.commands.executeCommand("verseAutoImports.snoozeAutoImport");
            await sleep(300);
            assert.strictEqual(globalAutoImport(), false, "auto-import must stay disabled while snoozed");

            await vscode.commands.executeCommand("verseAutoImports.cancelSnooze");
            await waitForGlobalAutoImport(true);
        } finally {
            // Never leak a snoozed state into later suites: cancel again and
            // clear the global override so the default (true) applies.
            await vscode.commands.executeCommand("verseAutoImports.cancelSnooze");
            await vscode.workspace.getConfiguration("verseAutoImports").update("general.autoImport", undefined, vscode.ConfigurationTarget.Global);
        }
    });
});

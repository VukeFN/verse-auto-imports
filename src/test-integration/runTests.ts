import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

/**
 * Launches the Layer-2 integration suite: downloads VS Code, opens the fake
 * UEFN fixture workspace, loads this extension from the repository root, and
 * runs the mocha suite inside the extension host.
 *
 * No language-stub extension is loaded: the manifest's own `languages`
 * contribution is what gives `.verse` the `verse` language id here, so the
 * activation suite fails if that contribution is ever dropped.
 */
async function main(): Promise<void> {
    // When the harness itself is started from a VS Code integrated terminal,
    // ELECTRON_RUN_AS_NODE=1 is inherited and makes the downloaded VS Code
    // run as plain Node, which then tries to execute the workspace file as a
    // script. Clear it so the test instance starts as a real VS Code.
    delete process.env.ELECTRON_RUN_AS_NODE;

    const repoRoot = path.resolve(__dirname, "..", "..");
    const extensionTestsPath = path.join(__dirname, "suite");

    // Run against a scratch copy of the fixture workspace: some flows under
    // test (Optimize Imports) save documents, and the checked-in fixtures must
    // stay pristine between runs.
    const workspaceSource = path.join(repoRoot, "test-fixtures", "integration-workspace");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verse-auto-imports-itest-"));
    fs.cpSync(workspaceSource, workspaceRoot, { recursive: true });
    const workspaceFile = path.join(workspaceRoot, "VerseAutoImportsIT.code-workspace");

    try {
        await runTests({
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath,
            launchArgs: [workspaceFile, "--disable-extensions", "--disable-workspace-trust", "--disable-gpu"],
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error("Integration test run failed:", error);
    process.exitCode = 1;
});

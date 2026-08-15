import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

/**
 * Packaging regression check: installs a built .vsix (path given as the first
 * CLI argument) into the test VS Code and runs only the activation suite
 * against it. Unlike runTests.ts the extension is NOT loaded from the repo,
 * so a packaging mistake (e.g. .vscodeignore excluding out/) fails here even
 * though the normal integration suite passes.
 */
async function main(): Promise<void> {
    delete process.env.ELECTRON_RUN_AS_NODE;

    const vsixArg = process.argv[2];
    if (!vsixArg) {
        throw new Error("Usage: node runVsixTest.js <path-to-vsix>");
    }
    const vsixPath = path.resolve(vsixArg);
    if (!fs.existsSync(vsixPath)) {
        throw new Error(`VSIX not found: ${vsixPath}`);
    }

    const repoRoot = path.resolve(__dirname, "..", "..");
    const hostAnchorPath = path.join(repoRoot, "test-fixtures", "vsix-host-anchor");
    const extensionTestsPath = path.join(__dirname, "vsix-suite");

    const workspaceSource = path.join(repoRoot, "test-fixtures", "integration-workspace");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verse-auto-imports-vsix-"));
    fs.cpSync(workspaceSource, workspaceRoot, { recursive: true });
    const workspaceFile = path.join(workspaceRoot, "VerseAutoImportsIT.code-workspace");

    try {
        const vscodeExecutablePath = await downloadAndUnzipVSCode();
        const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

        // On Windows the CLI is a .cmd, which needs a shell; quote everything
        // because the repo path contains spaces.
        const quote = (value: string): string => `"${value}"`;
        const installCommand = [quote(cliPath), ...cliArgs.map(quote), "--install-extension", quote(vsixPath)].join(" ");
        const install = cp.spawnSync(installCommand, { stdio: "inherit", shell: true });
        if (install.status !== 0) {
            throw new Error(`Failed to install ${vsixPath} (exit code ${String(install.status)})`);
        }

        await runTests({
            vscodeExecutablePath,
            // The anchor contributes nothing; it is here only because
            // --extensionTestsPath is ignored outside extension development
            // mode, and an empty path list silently never runs the suite. The
            // extension under test must come from the installed vsix, which
            // carries the `verse` language contribution itself - hence no
            // --disable-extensions either.
            extensionDevelopmentPath: [hostAnchorPath],
            extensionTestsPath,
            launchArgs: [workspaceFile, "--disable-workspace-trust", "--disable-gpu"],
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error("VSIX activation test run failed:", error);
    process.exitCode = 1;
});

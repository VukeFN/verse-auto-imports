import * as vscode from "vscode";
import { logger } from "../logger";
import { EnvironmentSnapshot } from "../environment";

/**
 * The logger is a singleton with a private constructor, so a test cannot take a
 * fresh one. Reset the state these tests touch instead, which keeps them
 * independent of the order they run in.
 */
function resetLogger(): void {
    const internals = logger as unknown as { environment?: EnvironmentSnapshot; logBuffer: string[] };
    internals.environment = undefined;
    internals.logBuffer = [];
}

function stubSettings(values: Record<string, unknown>): void {
    jest.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: jest.fn().mockImplementation((key: string) => values[key]),
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
}

const SNAPSHOT: EnvironmentSnapshot = {
    extensionVersion: "0.9.0",
    vscodeVersion: "1.85.0",
    platform: "win32",
    workspaceShape: "multi-root (2 folders)",
};

describe("Logger export header", () => {
    beforeEach(() => {
        resetLogger();
        stubSettings({ "general.autoImport": true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("names the build and the host once the environment is set", () => {
        logger.setEnvironment(SNAPSHOT);

        const lines = logger.getDebugLogsAsString().split("\n");

        expect(lines).toContain("Extension: 0.9.0");
        expect(lines).toContain("VS Code: 1.85.0");
        expect(lines).toContain("Platform: win32");
        expect(lines).toContain("Workspace: multi-root (2 folders)");
        expect(lines).toContain("Settings (at export):");
        expect(lines).toContain("  general.autoImport=true");
    });

    it("reports the settings as they stand at export, not as activation saw them", () => {
        logger.setEnvironment(SNAPSHOT);
        expect(logger.getDebugLogsAsString()).toContain("  general.autoImport=true");

        // What the status bar toggle does mid-session.
        stubSettings({ "general.autoImport": false });

        expect(logger.getDebugLogsAsString()).toContain("  general.autoImport=false");
    });

    it("puts the environment above the rule, so it reads as header rather than log", () => {
        logger.setEnvironment(SNAPSHOT);

        const lines = logger.getDebugLogsAsString().split("\n");

        expect(lines.indexOf("Extension: 0.9.0")).toBeGreaterThan(lines.indexOf("Entries: 0"));
        expect(lines.indexOf("Extension: 0.9.0")).toBeLessThan(lines.indexOf("-------------------------------------------"));
    });

    it("leaves the header unchanged when no environment was recorded", () => {
        const lines = logger.getDebugLogsAsString().split("\n");

        expect(lines[0]).toBe("Verse Auto Imports - Debug Log Export");
        expect(lines[1]).toMatch(/^Exported: /);
        expect(lines[2]).toBe("Entries: 0");
        expect(lines[3]).toBe("-------------------------------------------");
    });

    it("survives the buffer evicting the activation entries, which is what the header is for", () => {
        logger.setEnvironment(SNAPSHOT);
        logger.info("Extension", "Verse Auto Imports 0.9.0 is now active");

        // MAX_LOG_ENTRIES is 10000; one more than that evicts the oldest.
        for (let i = 0; i < 10000; i++) {
            logger.info("Extension", `noise ${i}`);
        }

        const exported = logger.getDebugLogsAsString();
        expect(exported).not.toContain("is now active");
        expect(exported).toContain("Extension: 0.9.0");
    });
});

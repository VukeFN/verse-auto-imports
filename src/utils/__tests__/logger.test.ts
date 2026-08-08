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

const SNAPSHOT: EnvironmentSnapshot = {
    extensionVersion: "0.9.0",
    vscodeVersion: "1.85.0",
    platform: "win32",
    workspaceShape: "multi-root (2 folders)",
    settings: { "general.autoImport": "true" },
};

describe("Logger export header", () => {
    beforeEach(() => {
        resetLogger();
    });

    it("names the build and the host once the environment is set", () => {
        logger.setEnvironment(SNAPSHOT);

        const lines = logger.getDebugLogsAsString().split("\n");

        expect(lines).toContain("Extension: 0.9.0");
        expect(lines).toContain("VS Code: 1.85.0");
        expect(lines).toContain("Platform: win32");
        expect(lines).toContain("Workspace: multi-root (2 folders)");
        expect(lines).toContain("  general.autoImport=true");
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

    it("survives the buffer wrapping, which is what the header is for", () => {
        logger.setEnvironment(SNAPSHOT);
        const internals = logger as unknown as { logBuffer: string[] };
        internals.logBuffer = new Array(10000).fill("[00:00:00.000] [INFO] [Extension] noise");

        expect(logger.getDebugLogsAsString()).toContain("Extension: 0.9.0");
    });
});

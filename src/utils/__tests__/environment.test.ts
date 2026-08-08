import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EnvironmentSnapshot, REPORTED_SETTINGS, SessionState, collectEnvironment, describeWorkspaceShape, formatEnvironmentLines, formatHostSummary, readSessionState } from "../environment";

/**
 * A context carrying only what the snapshot reads. Cast rather than built out:
 * ExtensionContext has a large surface and none of the rest is touched here.
 */
function makeContext(version?: string): vscode.ExtensionContext {
    const extension = version === undefined ? undefined : { packageJSON: { version } };
    return { extension } as unknown as vscode.ExtensionContext;
}

/** workspaceFolders and workspaceFile are readonly in the real typings; the mock is writable. */
function setWorkspace(folders: { uri: { fsPath: string }; name: string; index: number }[] | undefined, workspaceFile?: { fsPath: string }): void {
    const writable = vscode.workspace as unknown as { workspaceFolders: unknown; workspaceFile: unknown };
    writable.workspaceFolders = folders;
    writable.workspaceFile = workspaceFile;
}

function stubSettings(values: Record<string, unknown>): void {
    jest.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: jest.fn().mockImplementation((key: string) => values[key]),
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
}

function makeSnapshot(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
    return { extensionVersion: "0.9.0", vscodeVersion: "1.85.0", platform: "win32", ...overrides };
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
    return { workspaceShape: "single folder", settings: {}, ...overrides };
}

describe("describeWorkspaceShape", () => {
    it("reports no folder open", () => {
        expect(describeWorkspaceShape(0, false)).toBe("no folder open");
    });

    it("reports a single folder", () => {
        expect(describeWorkspaceShape(1, false)).toBe("single folder");
    });

    it("reports the folder count when multi-root", () => {
        expect(describeWorkspaceShape(3, false)).toBe("multi-root (3 folders)");
    });

    it("distinguishes a one-folder .code-workspace from a plain folder", () => {
        expect(describeWorkspaceShape(1, true)).toBe("workspace file, 1 folder");
    });

    it("reports a workspace file that has no folders", () => {
        expect(describeWorkspaceShape(0, true)).toBe("workspace file, no folders");
    });
});

describe("REPORTED_SETTINGS", () => {
    it("names only settings the package.json actually contributes", () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
        const contributed = Object.keys(manifest.contributes.configuration.properties);

        // A key renamed in package.json and missed here degrades silently to
        // "undefined" in the header, which is worse than not reporting it.
        for (const key of REPORTED_SETTINGS) {
            expect(contributed).toContain(`verseAutoImports.${key}`);
        }
    });
});

describe("readSessionState", () => {
    afterEach(() => {
        setWorkspace(undefined);
        jest.restoreAllMocks();
    });

    it("reads the five settings that change import behavior under test", () => {
        stubSettings({
            "general.autoImport": false,
            "behavior.importSyntax": "inline",
            "behavior.importGrouping": "separate",
            "behavior.preserveImportLocations": true,
            "behavior.sortImportsAlphabetically": false,
        });

        expect(readSessionState().settings).toEqual({
            "general.autoImport": "false",
            "behavior.importSyntax": "inline",
            "behavior.importGrouping": "separate",
            "behavior.preserveImportLocations": "true",
            "behavior.sortImportsAlphabetically": "false",
        });
    });

    it("flattens a value carrying a newline, so it cannot forge a header line", () => {
        stubSettings({ "behavior.importSyntax": "inline\nExtension: 9.9.9" });

        expect(readSessionState().settings["behavior.importSyntax"]).toBe("inline Extension: 9.9.9");
    });

    it("reads settings at call time, so a mid-session toggle is reflected", () => {
        stubSettings({ "general.autoImport": true });
        expect(readSessionState().settings["general.autoImport"]).toBe("true");

        stubSettings({ "general.autoImport": false });
        expect(readSessionState().settings["general.autoImport"]).toBe("false");
    });

    it("reads the workspace shape at call time, so a folder added mid-session is reflected", () => {
        stubSettings({});
        setWorkspace([{ uri: { fsPath: "/a" }, name: "a", index: 0 }]);
        expect(readSessionState().workspaceShape).toBe("single folder");

        setWorkspace([
            { uri: { fsPath: "/a" }, name: "a", index: 0 },
            { uri: { fsPath: "/b" }, name: "b", index: 1 },
        ]);

        expect(readSessionState().workspaceShape).toBe("multi-root (2 folders)");
    });

    it("records no workspace path, so an exported log carries no account name", () => {
        stubSettings({});
        setWorkspace([{ uri: { fsPath: "C:/Users/someone/project" }, name: "project", index: 0 }], { fsPath: "C:/Users/someone/project.code-workspace" });

        const rendered = formatEnvironmentLines(makeSnapshot(), readSessionState()).join("\n");

        expect(rendered).not.toContain("someone");
        expect(rendered).not.toContain("project");
    });
});

describe("collectEnvironment", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("records the extension version and the host version", () => {
        const snapshot = collectEnvironment(makeContext("0.9.0"));

        expect(snapshot.extensionVersion).toBe("0.9.0");
        expect(snapshot.vscodeVersion).toBe("1.85.0");
    });

    it("records the host platform", () => {
        const original = Object.getOwnPropertyDescriptor(process, "platform");
        Object.defineProperty(process, "platform", { value: "sunos", configurable: true });

        try {
            expect(collectEnvironment(makeContext("0.9.0")).platform).toBe("sunos");
        } finally {
            Object.defineProperty(process, "platform", original!);
        }
    });

    it("falls back to unknown rather than throwing when the host supplies no extension", () => {
        expect(collectEnvironment(makeContext()).extensionVersion).toBe("unknown");
    });
});

describe("formatHostSummary", () => {
    it("names the host and the workspace shape on one line", () => {
        expect(formatHostSummary(makeSnapshot(), makeState())).toBe("VS Code 1.85.0, win32, single folder");
    });
});

describe("formatEnvironmentLines", () => {
    it("carries every field and says which of them were read at export", () => {
        const lines = formatEnvironmentLines(makeSnapshot(), makeState({ settings: { "general.autoImport": "true", "behavior.importSyntax": "block" } }));

        expect(lines).toEqual([
            "Extension: 0.9.0",
            "VS Code: 1.85.0",
            "Platform: win32",
            "Workspace (at export): single folder",
            "Settings (at export):",
            "  general.autoImport=true",
            "  behavior.importSyntax=block",
        ]);
    });
});

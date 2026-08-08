import * as vscode from "vscode";
import { EnvironmentSnapshot, collectEnvironment, describeWorkspaceShape, formatEnvironmentLines, formatEnvironmentSummary } from "../environment";

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

function makeSnapshot(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
    return {
        extensionVersion: "0.9.0",
        vscodeVersion: "1.85.0",
        platform: "win32",
        workspaceShape: "single folder",
        settings: { "general.autoImport": "true" },
        ...overrides,
    };
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

describe("collectEnvironment", () => {
    afterEach(() => {
        setWorkspace(undefined);
        jest.restoreAllMocks();
    });

    function stubSettings(values: Record<string, unknown>): void {
        jest.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
            get: jest.fn().mockImplementation((key: string) => values[key]),
        } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
    }

    it("records the extension version, the host and the workspace shape", () => {
        stubSettings({});
        setWorkspace([
            { uri: { fsPath: "/a" }, name: "a", index: 0 },
            { uri: { fsPath: "/b" }, name: "b", index: 1 },
        ]);

        const snapshot = collectEnvironment(makeContext("0.9.0"));

        expect(snapshot.extensionVersion).toBe("0.9.0");
        expect(snapshot.vscodeVersion).toBe("1.85.0");
        expect(snapshot.platform).toBe(process.platform);
        expect(snapshot.workspaceShape).toBe("multi-root (2 folders)");
    });

    it("records the five settings that change behaviour under test", () => {
        stubSettings({
            "general.autoImport": false,
            "behavior.importSyntax": "inline",
            "behavior.importGrouping": "separate",
            "behavior.preserveImportLocations": true,
            "behavior.sortImportsAlphabetically": false,
        });

        const snapshot = collectEnvironment(makeContext("0.9.0"));

        expect(snapshot.settings).toEqual({
            "general.autoImport": "false",
            "behavior.importSyntax": "inline",
            "behavior.importGrouping": "separate",
            "behavior.preserveImportLocations": "true",
            "behavior.sortImportsAlphabetically": "false",
        });
    });

    it("falls back to unknown rather than throwing when the host supplies no extension", () => {
        stubSettings({});

        expect(collectEnvironment(makeContext()).extensionVersion).toBe("unknown");
    });

    it("records no workspace path, so an exported log carries no account name", () => {
        stubSettings({});
        setWorkspace([{ uri: { fsPath: "C:/Users/someone/project" }, name: "project", index: 0 }], { fsPath: "C:/Users/someone/project.code-workspace" });

        const rendered = formatEnvironmentLines(collectEnvironment(makeContext("0.9.0"))).join("\n");

        expect(rendered).not.toContain("someone");
        expect(rendered).not.toContain("project");
    });
});

describe("formatEnvironmentSummary", () => {
    it("names the host and the workspace shape on one line", () => {
        expect(formatEnvironmentSummary(makeSnapshot())).toBe("VS Code 1.85.0, win32, single folder");
    });
});

describe("formatEnvironmentLines", () => {
    it("carries every field of the snapshot", () => {
        const lines = formatEnvironmentLines(
            makeSnapshot({
                settings: { "general.autoImport": "true", "behavior.importSyntax": "block" },
            }),
        );

        expect(lines).toEqual(["Extension: 0.9.0", "VS Code: 1.85.0", "Platform: win32", "Workspace: single folder", "Settings:", "  general.autoImport=true", "  behavior.importSyntax=block"]);
    });
});

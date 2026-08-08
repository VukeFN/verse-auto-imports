import * as vscode from "vscode";

/**
 * Identifying facts about the build and the host that produced a log.
 *
 * Deliberately holds no folder name, path or URI: an exported debug log is a
 * file people attach to bug reports, and a workspace path names the account it
 * came from. Shape is reported as counts and a flag instead.
 */
export interface EnvironmentSnapshot {
    extensionVersion: string;
    vscodeVersion: string;
    platform: string;
    workspaceShape: string;
    settings: Record<string, string>;
}

/**
 * The settings that change behaviour under test, so a log can be read against
 * the configuration that produced it rather than against the defaults.
 */
const REPORTED_SETTINGS = ["general.autoImport", "behavior.importSyntax", "behavior.importGrouping", "behavior.preserveImportLocations", "behavior.sortImportsAlphabetically"] as const;

/**
 * Describes the workspace as a shape rather than a location. Multi-root and
 * single-folder workspaces discover digests differently, so which one was open
 * is the part worth recording.
 */
export function describeWorkspaceShape(folderCount: number, hasWorkspaceFile: boolean): string {
    if (folderCount === 0) {
        return hasWorkspaceFile ? "workspace file, no folders" : "no folder open";
    }
    if (folderCount === 1) {
        return hasWorkspaceFile ? "workspace file, 1 folder" : "single folder";
    }
    return `multi-root (${folderCount} folders)`;
}

/**
 * Reads the snapshot from the host. The only part of this module that touches
 * vscode, so everything below it stays testable without the extension runtime.
 */
export function collectEnvironment(context: vscode.ExtensionContext): EnvironmentSnapshot {
    const config = vscode.workspace.getConfiguration("verseAutoImports");
    const settings: Record<string, string> = {};
    for (const key of REPORTED_SETTINGS) {
        settings[key] = String(config.get(key));
    }

    return {
        // context.extension is absent on hosts older than the engine this
        // extension declares. Activation must not throw over a log line.
        extensionVersion: context.extension?.packageJSON?.version ?? "unknown",
        vscodeVersion: vscode.version,
        platform: process.platform,
        workspaceShape: describeWorkspaceShape(vscode.workspace.workspaceFolders?.length ?? 0, vscode.workspace.workspaceFile !== undefined),
        settings,
    };
}

/**
 * One line for the activation log: which build, on which host, against which
 * workspace shape.
 */
export function formatEnvironmentSummary(snapshot: EnvironmentSnapshot): string {
    return `VS Code ${snapshot.vscodeVersion}, ${snapshot.platform}, ${snapshot.workspaceShape}`;
}

/**
 * The block for the exported log's header. It repeats what activation logged
 * because the log buffer is circular: a long session pushes the activation
 * entries out of the export, and the header is what survives.
 */
export function formatEnvironmentLines(snapshot: EnvironmentSnapshot): string[] {
    return [
        `Extension: ${snapshot.extensionVersion}`,
        `VS Code: ${snapshot.vscodeVersion}`,
        `Platform: ${snapshot.platform}`,
        `Workspace: ${snapshot.workspaceShape}`,
        "Settings:",
        ...Object.entries(snapshot.settings).map(([key, value]) => `  ${key}=${value}`),
    ];
}

import * as vscode from "vscode";

/**
 * Identifying facts about the build and the host that produced a log. Only
 * things that do not move while the window is open: the settings are toggled
 * by the extension's own status bar menu, so they are read where they are
 * reported rather than captured here.
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
}

/**
 * The settings that change import behavior under test, so a log can be read
 * against the configuration that produced it rather than against the defaults.
 * Every key must exist in the package.json configuration contribution; a key
 * that does not would report "undefined" in the one artifact meant to be
 * trustworthy, which is what environment.test.ts pins.
 */
export const REPORTED_SETTINGS = ["general.autoImport", "behavior.importSyntax", "behavior.importGrouping", "behavior.preserveImportLocations", "behavior.sortImportsAlphabetically"] as const;

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
 * Reads the reported settings as they stand now. Called at each point that
 * reports them, never cached: the status bar menu writes all five, so a value
 * captured at activation would describe a session that had already ended.
 */
export function readReportedSettings(): Record<string, string> {
    const config = vscode.workspace.getConfiguration("verseAutoImports");
    const settings: Record<string, string> = {};
    for (const key of REPORTED_SETTINGS) {
        // Flattened to one line: VS Code does not enforce a setting's declared
        // type, and a value carrying a newline would forge header lines.
        settings[key] = String(config.get(key)).replace(/[\r\n]+/g, " ");
    }
    return settings;
}

/**
 * Reads the snapshot from the host. The only part of this module that touches
 * vscode besides the settings read, so everything below stays testable without
 * the extension runtime.
 */
export function collectEnvironment(context: vscode.ExtensionContext): EnvironmentSnapshot {
    return {
        // context.extension is absent on hosts older than the engine this
        // extension declares. Activation must not throw over a log line.
        extensionVersion: context.extension?.packageJSON?.version ?? "unknown",
        vscodeVersion: vscode.version,
        platform: process.platform,
        workspaceShape: describeWorkspaceShape(vscode.workspace.workspaceFolders?.length ?? 0, vscode.workspace.workspaceFile !== undefined),
    };
}

/**
 * The host half of the activation line. The version is not repeated here: the
 * activation line already leads with it.
 */
export function formatHostSummary(snapshot: EnvironmentSnapshot): string {
    return `VS Code ${snapshot.vscodeVersion}, ${snapshot.platform}, ${snapshot.workspaceShape}`;
}

/**
 * The block for the exported log's header. It repeats what activation logged
 * because the log buffer is circular: a long session pushes the activation
 * entries out of the export, and the header is what survives.
 */
export function formatEnvironmentLines(snapshot: EnvironmentSnapshot, settingsAtExport: Record<string, string>): string[] {
    return [
        `Extension: ${snapshot.extensionVersion}`,
        `VS Code: ${snapshot.vscodeVersion}`,
        `Platform: ${snapshot.platform}`,
        `Workspace: ${snapshot.workspaceShape}`,
        // Labelled with when they were read, because the status bar can change
        // them mid-session: these are not necessarily what activation saw.
        "Settings (at export):",
        ...Object.entries(settingsAtExport).map(([key, value]) => `  ${key}=${value}`),
    ];
}

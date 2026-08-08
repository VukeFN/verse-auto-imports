import * as vscode from "vscode";

/**
 * The facts that identify a build and cannot change while the window is open.
 * Everything that can change is SessionState, read where it is reported.
 */
export interface EnvironmentSnapshot {
    extensionVersion: string;
    vscodeVersion: string;
    platform: string;
}

/**
 * The half of the picture that moves mid-session: the status bar menu writes
 * all five settings, and folders are added and removed without restarting the
 * extension host. A value captured at activation would describe a session that
 * had already changed, which is worse in a diagnostics artifact than no value.
 *
 * Deliberately holds no folder name, path or URI: an exported debug log is a
 * file people attach to bug reports, and a workspace path names the account it
 * came from. Shape is reported as counts and a flag instead.
 */
export interface SessionState {
    workspaceShape: string;
    settings: Record<string, string>;
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
 * Reads the moving half as it stands now. Called at each point that reports it,
 * never cached.
 */
export function readSessionState(): SessionState {
    const config = vscode.workspace.getConfiguration("verseAutoImports");
    const settings: Record<string, string> = {};
    for (const key of REPORTED_SETTINGS) {
        // Flattened to one line: VS Code does not enforce a setting's declared
        // type, and a value carrying a newline would forge header lines.
        settings[key] = String(config.get(key)).replace(/[\r\n]+/g, " ");
    }

    return {
        workspaceShape: describeWorkspaceShape(vscode.workspace.workspaceFolders?.length ?? 0, vscode.workspace.workspaceFile !== undefined),
        settings,
    };
}

/**
 * Reads the fixed half from the host, once at activation.
 */
export function collectEnvironment(context: vscode.ExtensionContext): EnvironmentSnapshot {
    return {
        // context.extension is absent on hosts older than the engine this
        // extension declares. Activation must not throw over a log line.
        extensionVersion: context.extension?.packageJSON?.version ?? "unknown",
        vscodeVersion: vscode.version,
        platform: process.platform,
    };
}

/**
 * The host half of the activation line. The version is not repeated here: the
 * activation line already leads with it.
 */
export function formatHostSummary(snapshot: EnvironmentSnapshot, state: SessionState): string {
    return `VS Code ${snapshot.vscodeVersion}, ${snapshot.platform}, ${state.workspaceShape}`;
}

/**
 * The block for the exported log's header. It repeats what activation logged
 * because the log buffer is circular: a long session pushes the activation
 * entries out of the export, and the header is what survives.
 *
 * The moving fields say when they were read, so a reader cannot mistake them
 * for what activation saw.
 */
export function formatEnvironmentLines(snapshot: EnvironmentSnapshot, state: SessionState): string[] {
    return [
        `Extension: ${snapshot.extensionVersion}`,
        `VS Code: ${snapshot.vscodeVersion}`,
        `Platform: ${snapshot.platform}`,
        `Workspace (at export): ${state.workspaceShape}`,
        "Settings (at export):",
        ...Object.entries(state.settings).map(([key, value]) => `  ${key}=${value}`),
    ];
}

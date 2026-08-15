import * as vscode from "vscode";

/** The configuration section every setting this extension contributes lives under. */
export const SECTION = "verseAutoImports";

/**
 * The extension's configuration, resolved for `resource` when the caller has
 * one. Settings declared `"scope": "resource"` in package.json only resolve a
 * folder's value when the read passes the file it is deciding about; without
 * one they answer for the window, and a folder override is ignored in silence.
 *
 * @param resource The file the setting is being read about. A `Uri` and never a
 * `TextDocument`: a document carries a languageId, which would also switch on
 * `[verse]` language-block resolution, and nothing here consults those.
 */
export function settingsFor(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION, resource);
}

/**
 * The level a write must land on for the user to see it take effect: the one
 * that already holds an override, because a more specific level outranks
 * anything written below it. Writing Global under a workspace override changes
 * a value nothing reads, which reads to the user as a toggle that does nothing.
 *
 * @param scopedToResource Whether `config` was obtained with a resource. Only
 * then may WorkspaceFolder be returned - `update` throws when it is asked for a
 * workspace folder on a configuration that is not scoped to a resource.
 */
export function writeTargetFor(config: vscode.WorkspaceConfiguration, key: string, scopedToResource: boolean): vscode.ConfigurationTarget {
    // Absent for an unregistered key, and for anything that is not a leaf of
    // the configuration tree.
    const info = config.inspect(key);
    if (scopedToResource && info?.workspaceFolderValue !== undefined) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (info?.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}

/**
 * Writes a setting to whichever level already overrides it, falling back to
 * user settings when nothing does.
 */
export async function writeSetting(key: string, value: unknown, resource?: vscode.Uri): Promise<void> {
    const config = settingsFor(resource);
    await config.update(key, value, writeTargetFor(config, key, resource !== undefined));
}

/**
 * Reads the explicit user-set value of a setting, ignoring its registered
 * default. config.get cannot distinguish the two: for a registered setting it
 * returns the package.json default instead of the passed fallback.
 * Language-scoped values ("[verse]" blocks) are intentionally not consulted;
 * callers pass a config fetched without a scope, so they have never applied
 * here.
 */
export function explicitSetting(config: vscode.WorkspaceConfiguration, key: string): number | undefined {
    const info = config.inspect<number>(key);
    return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

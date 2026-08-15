import * as vscode from "vscode";

/** The configuration section every setting this extension contributes lives under. */
const SECTION = "verseAutoImports";

/**
 * The settings package.json declares `"scope": "resource"`, and so the only
 * ones a workspace folder may hold. Kept here rather than read back from the
 * manifest because the write path needs it on every toggle; a test asserts the
 * two agree, so a setting whose scope changes fails there rather than at a
 * user's keystroke.
 *
 * The presence of a `workspaceFolderValue` cannot stand in for this list. A
 * single-root workspace registers one model as both its workspace and its
 * folder configuration, so inspect() reports a folder value for window-scoped
 * settings too - and update() rejects those, per its "window configuration to
 * workspace folder" contract.
 */
export const RESOURCE_SCOPED: ReadonlySet<string> = new Set([
    "behavior.emptyLinesAfterImports",
    "behavior.importGrouping",
    "behavior.importSyntax",
    "behavior.multiOptionStrategy",
    "behavior.preserveImportLocations",
    "behavior.sortImportsAlphabetically",
    "general.autoImport",
    "moduleVisibility.definitionsFileName",
    "pathConversion.enableCodeLens",
    "quickFix.showDescriptions",
    "quickFix.sortAlphabetically",
]);

/** The file the user is looking at, which command surfaces resolve settings against. */
export function activeResource(): vscode.Uri | undefined {
    return vscode.window.activeTextEditor?.document.uri;
}

/**
 * The extension's configuration, resolved for `resource` when the caller has
 * one. Settings declared `"scope": "resource"` in package.json only resolve a
 * folder's value when the read passes the file it is deciding about; without
 * one they answer for the window, and a folder override is ignored in silence.
 *
 * @param resource The file or folder the setting is being read about. A `Uri`
 * and never a `TextDocument`: a document carries a languageId, which would also
 * switch on `[verse]` language-block resolution, and nothing here consults those.
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
 * Both conditions on WorkspaceFolder are throw conditions of `update`, not
 * preferences: it rejects a workspace folder asked of a configuration that is
 * not scoped to a resource, and rejects one asked for a window-scoped setting.
 *
 * @param scopedToResource Whether `config` was obtained with a resource.
 */
export function writeTargetFor(config: vscode.WorkspaceConfiguration, key: string, scopedToResource: boolean): vscode.ConfigurationTarget {
    // Absent for an unregistered key, and for anything that is not a leaf of
    // the configuration tree.
    const info = config.inspect(key);
    if (scopedToResource && RESOURCE_SCOPED.has(key) && info?.workspaceFolderValue !== undefined) {
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

import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../utils";

/** The Content folder that anchors every importable module location. */
const CONTENT_FOLDER = "Content";

/** The directory UEFN nests a project's plugins under. */
const PLUGINS_FOLDER = "Plugins";

/**
 * Where the project's Content root can sit inside a workspace folder,
 * shallowest first, as workspace-relative forward-slash paths with "" for the
 * folder itself.
 *
 * UEFN's shipped layout puts Verse under `<project>/Plugins/<Name>/Content` and
 * the workspace it generates opens at that Content folder, so a workspace
 * opened at the project root instead reaches it three levels down. A boundary
 * that only admits depth zero finds nothing in such a project.
 *
 * Shallowest first, and only the root plugin's Content below the top level:
 * both rules come from ImportPathConverter.placeUnderContentRoot, which is what
 * a caller holding a document uses. A Content below the root is an ordinary
 * folder module, and a second plugin's Content answers to a Verse path of its
 * own rather than to this project's.
 *
 * @param rootPluginName `plugins[bIsRoot].name` from the project file; without
 * one there is no evidence for a nested root, so only the top two are offered.
 */
export function contentRootCandidates(workspaceFolderPath: string, rootPluginName: string | null): string[] {
    if (path.basename(workspaceFolderPath) === CONTENT_FOLDER) {
        return [""];
    }

    const candidates = [CONTENT_FOLDER];
    if (rootPluginName) {
        candidates.push(`${PLUGINS_FOLDER}/${rootPluginName}/${CONTENT_FOLDER}`);
    }

    return candidates;
}

/**
 * The project's Content root inside a workspace folder, or null when the folder
 * holds none.
 *
 * Returned absolute, so a caller maps a file back through
 * `path.relative(contentRoot, file)` rather than by stripping a prefix it
 * spelled itself. That matters because the nested candidate is composed from
 * the plugin name the project file declares, which is matched against a
 * directory rather than resolved and so need not match its case: the relative
 * step then folds exactly as far as the stat that found the root did.
 */
export async function findContentRoot(workspaceFolder: { uri: vscode.Uri }, rootPluginName: string | null): Promise<vscode.Uri | null> {
    for (const candidate of contentRootCandidates(workspaceFolder.uri.fsPath, rootPluginName)) {
        // The workspace folder is the Content folder itself, which is what it
        // is named rather than what is under it - nothing to stat.
        if (candidate === "") {
            return workspaceFolder.uri;
        }

        const uri = vscode.Uri.joinPath(workspaceFolder.uri, candidate);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
                return uri;
            }
        } catch {
            // Absent, which is the ordinary answer for every candidate but one.
        }
    }

    logger.debug("contentRoot", `No Content root under ${workspaceFolder.uri.fsPath} (root plugin: ${rootPluginName ?? "none"})`);
    return null;
}

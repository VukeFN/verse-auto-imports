import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../utils";
import { sameFsSegment } from "./pathCasing";

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
 * A name carrying a path separator or a relative segment is refused rather than
 * joined: `Uri.joinPath` would resolve it, and a `..` in the project file would
 * put the root outside the workspace folder, where the visibility writer would
 * then create its definitions file.
 * @param projectFileDirectory the directory holding the `.uefnproject`, which
 * anchors `Plugins/<root>/Content` where the workspace folder is opened above
 * or below the project root. A composition that escapes the workspace folder
 * is dropped rather than offered: no glob rooted in the folder would reach it,
 * and the visibility writer must not create files outside the workspace.
 */
export function contentRootCandidates(workspaceFolderPath: string, rootPluginName: string | null, projectFileDirectory: string | null = null): string[] {
    // Under the platform's case rule, because the stat that accepts every
    // other candidate is case-insensitive on Windows: a byte-exact test here
    // would refuse a workspace opened at an on-disk `content` while the same
    // folder passes everywhere else.
    if (sameFsSegment(path.basename(workspaceFolderPath), CONTENT_FOLDER)) {
        return [""];
    }

    const candidates = [CONTENT_FOLDER];
    if (rootPluginName && /^[^\\/:*?"<>|]+$/.test(rootPluginName) && rootPluginName !== "." && rootPluginName !== "..") {
        if (projectFileDirectory) {
            const composed = path
                .relative(workspaceFolderPath, path.join(projectFileDirectory, PLUGINS_FOLDER, rootPluginName, CONTENT_FOLDER))
                .split(path.sep)
                .join("/");
            if (composed !== "" && composed.split("/")[0] !== ".." && !path.isAbsolute(composed)) {
                candidates.push(composed);
            }
        }
        candidates.push(`${PLUGINS_FOLDER}/${rootPluginName}/${CONTENT_FOLDER}`);
    }

    // Shallowest first is the depth rule; the project-file composition can
    // land at any depth, including on top of a fixed candidate.
    return [...new Set(candidates)].sort((a, b) => a.split("/").length - b.split("/").length);
}

/**
 * The project's Content root inside a workspace folder, or null when the folder
 * holds none.
 *
 * Returned absolute, so a caller maps a file back through
 * `path.relative(contentRoot, file)` rather than by stripping a prefix it
 * spelled itself. The nested candidate carries the plugin name as the project
 * file spells it, which is matched against a directory rather than resolved,
 * so it need not match the directory's case; relating two absolute paths folds
 * as far as the platform does, which on Windows - where UEFN runs - is as far
 * as the stat that found the root did.
 */
export async function findContentRoot(workspaceFolder: { uri: vscode.Uri }, rootPluginName: string | null, projectFileDirectory: string | null = null): Promise<vscode.Uri | null> {
    for (const candidate of contentRootCandidates(workspaceFolder.uri.fsPath, rootPluginName, projectFileDirectory)) {
        // The workspace folder is the Content folder itself, which is what it
        // is named rather than what is under it - nothing to stat.
        if (candidate === "") {
            return workspaceFolder.uri;
        }

        const uri = vscode.Uri.joinPath(workspaceFolder.uri, candidate);
        try {
            const stat = await vscode.workspace.fs.stat(uri);

            // A bitmask, not a value: the disk provider ORs SymbolicLink onto
            // the target's type, so an equality test rejects a Content root
            // reached through a symlink or a junction. The scans this feeds
            // used to glob without stating at all, and findFiles follows links
            // by default, so such a root has to keep working.
            if ((stat.type & vscode.FileType.Directory) !== 0) {
                return uri;
            }
        } catch {
            // Absent, which is the ordinary answer for every candidate but one.
        }
    }

    logger.debug("contentRoot", `No Content root under ${workspaceFolder.uri.fsPath} (root plugin: ${rootPluginName ?? "none"})`);
    return null;
}

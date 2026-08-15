import * as vscode from "vscode";
import * as path from "path";
import { logger } from "../utils";
import { maskCommentsAndStrings } from "../utils/verseText";
import { ProjectPathHandler } from "../project";
import { ProjectPathCache } from "../services";
import { resolveFolderModuleLocations, toContentRelativeDir } from "../services/moduleLocationLookup";
import { ImportFormatter } from "./ImportFormatter";
import { LINE_SPLIT, scanConvertibleImports } from "./ImportScanner";

/** A conversion resolved but not yet written, ready for applyConversion. */
interface ImportConversionResult {
    originalImport: string;
    /**
     * The statement to write in place of `originalImport`, whichever direction
     * the conversion runs: convertToFullPath puts the absolute form here and
     * convertFromFullPath the relative one.
     *
     * Empty while `isAmbiguous`, where the statement cannot be built until the
     * user has picked from `possiblePaths`.
     */
    convertedImport: string;
    moduleName: string;
    /** Whether the module resolved to more than one location, listed in `possiblePaths`. */
    isAmbiguous: boolean;
    possiblePaths?: string[];
    /**
     * The line the conversion acts on, where the caller knows it. Statement text
     * is not unique in a document, so this is what keeps the edit on the line the
     * user chose rather than on the first line that reads the same.
     */
    line?: number;
}

const CONTENT_FOLDER = "Content";

/**
 * How many `.verse` files the project-wide folder search enumerates. Far above
 * the explicit-declaration scan's 100 because this one reads no file contents:
 * it derives folder modules from the paths alone, so a file costs a string
 * split rather than a read.
 */
const FOLDER_SCAN_FILE_LIMIT = 5000;

/**
 * Converts a `using` between the absolute Verse path of a module and the
 * relative reference to it, in either direction, and writes the result.
 *
 * The two directions are not mirror images. Going relative shortens a path the
 * file already carries; going absolute has to find where the module lives,
 * which is a workspace search, so only that direction can come back ambiguous.
 */
export class ImportPathConverter {
    private readonly projectPathHandler: ProjectPathHandler;
    private projectPathCache: ProjectPathCache | null = null;
    private readonly formatter = new ImportFormatter();

    constructor(
        private readonly outputChannel: vscode.OutputChannel,
        projectPathCache?: ProjectPathCache,
    ) {
        this.projectPathHandler = new ProjectPathHandler(outputChannel);
        this.projectPathCache = projectPathCache || null;
    }

    /**
     * Gives the converter a declaration cache to look module locations up in,
     * sparing the workspace scan. Optional: with none, findModuleLocations
     * scans every time.
     */
    setProjectPathCache(cache: ProjectPathCache): void {
        this.projectPathCache = cache;
    }

    private async folderExists(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): Promise<boolean> {
        const folderUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
        try {
            const stat = await vscode.workspace.fs.stat(folderUri);
            const isDirectory = stat.type === vscode.FileType.Directory;
            logger.debug("ImportPathConverter", `Checking folder: ${folderUri.fsPath} - Exists: ${isDirectory}, Type: ${stat.type}`);
            return isDirectory;
        } catch (error) {
            logger.debug("ImportPathConverter", `Folder check failed for: ${folderUri.fsPath} - Error: ${error}`);
            return false;
        }
    }

    /** Whether a workspace-relative path is still a file, which a cached declaration's source may no longer be. */
    private async sourceFileExists(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): Promise<boolean> {
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder.uri, relativePath));
            return stat.type === vscode.FileType.File;
        } catch {
            return false;
        }
    }

    /**
     * The absolute Verse path of a module resolved at a location.
     *
     * @param location Follows the findModuleLocations contract: "" or "/Dir/Sub", relative to the Content root
     * @param modulePath Separated by "/", not by the dots the relative form is written with
     */
    static buildFullVersePath(projectVersePath: string, location: string, modulePath: string): string {
        return location === "/" || location === "" ? `${projectVersePath}/${modulePath}` : `${projectVersePath}${location}/${modulePath}`;
    }

    /**
     * A regex matching an explicit declaration of one named module, in any of
     * the three styles Verse writes a macro body in: `module:`, `module { }`
     * with the brace on either that line or the next, and the dotted
     * `module. Inner := ...`. A `>` after the keyword is accepted alongside
     * them.
     *
     * No visibility keyword list appears here: nothing reads which specifier
     * was found, only whether this file declares the module, so any `<...>`
     * entry is accepted - a `scoped{A, B}` list included, whose specifier does
     * not end at its keyword.
     *
     * A specifier body must exclude `<` and newlines. A body free to span lines
     * lets a `<` that opens nothing - a comparison operator, say - run on to
     * the `>` of a LATER declaration's specifier, reporting a file that
     * declares no such module. The narrowing holds whether or not the text is
     * masked first, and nothing binds a caller of this builder to mask, so it
     * cannot be widened to MODULE_DECLARATION's `[^>]`.
     *
     * Non-global on purpose: the pattern is reused with `.test()` across many
     * files, and a global flag would carry `lastIndex` between calls and skip
     * valid definitions depending on the order the files are read in.
     */
    static buildModuleDefinitionRegex(moduleName: string): RegExp {
        const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}(?:'[^']*')?(?:\\s*<[^<>\\n]+>)*\\s*:=\\s*module\\s*[:>{.]`, "m");
    }

    /**
     * The path a `using` statement names, with any trailing comment removed,
     * or "" when the statement names nothing.
     *
     * Read through ImportFormatter rather than from a copy of its patterns, so
     * the converter cannot disagree with the rest of the extension about how
     * much of a line the statement occupies. A copy that ends the dotted form
     * at end of line instead converts whatever a line writes after its
     * statement along with the path.
     *
     * "" where the formatter answers null, because isFullPathImport and
     * isBuiltinModule test the result as a string.
     */
    private extractPathFromImport(importStatement: string): string {
        return this.formatter.extractPathFromImport(importStatement) ?? "";
    }

    /**
     * Whether the author wrote the braced style rather than the dotted one.
     *
     * Judged on the statement minus any trailing comment: a `{` is legal in
     * comment prose but not in a module path, so testing the raw line lets a
     * comment decide the syntax the conversion emits. This is the one reader
     * that looks at the whole statement rather than at a capture taken from
     * it, which is why it needs its own strip.
     */
    private static usesBracedStyle(importStatement: string): boolean {
        return ImportFormatter.stripTrailingComment(importStatement).includes("{");
    }

    /** Whether an import already names an absolute path: a leading "/", or an Epic account somewhere in it. */
    isFullPathImport(importStatement: string): boolean {
        const path = this.extractPathFromImport(importStatement);
        return path.startsWith("/") || path.includes("@fortnite.com");
    }

    /**
     * Whether an import comes from Fortnite.com, UnrealEngine.com or Verse.org,
     * which have no relative form to convert to.
     *
     * The three are fixed here, unlike the digest prefixes ImportFormatter
     * reads from `behavior.digestImportPrefixes`: a prefix the user adds is a
     * grouping preference, not a claim that a module lives outside the project.
     */
    isBuiltinModule(importStatement: string): boolean {
        const path = this.extractPathFromImport(importStatement);
        return path.startsWith("/Fortnite.com/") || path.startsWith("/UnrealEngine.com/") || path.startsWith("/Verse.org/");
    }

    /**
     * The module an import names, as a "/"-separated path and the last segment
     * of it, or null when the statement names nothing.
     *
     * Both forms leave here separated the same way: an absolute path unchanged,
     * and a relative `HUD.Textures` with its dots turned into "/". Which of the
     * two it was is still readable from the leading "/".
     */
    extractModuleFromImport(importStatement: string): { fullPath: string; moduleName: string } | null {
        const pathStr = this.extractPathFromImport(importStatement);
        if (!pathStr) return null;

        if (pathStr.startsWith("/")) {
            const segments = pathStr.split("/").filter((s) => s);
            const lastSegment = segments[segments.length - 1];
            const moduleName = lastSegment.includes("@") ? lastSegment.split("@")[0] : lastSegment;
            return { fullPath: pathStr, moduleName };
        }

        const identPattern = /[A-Za-z_][A-Za-z0-9_]*(?:'[^']*')?/g;
        const dotSegments: string[] = [];
        let match;
        const tempPath = pathStr.replace(/\s+/g, "");
        while ((match = identPattern.exec(tempPath)) !== null) {
            dotSegments.push(match[0]);
        }

        if (dotSegments.length === 0) {
            const simpleSplit = pathStr
                .split(".")
                .map((s) => s.trim())
                .filter((s) => s);
            if (simpleSplit.length === 0) return null;
            return {
                fullPath: simpleSplit.join("/"),
                moduleName: simpleSplit[simpleSplit.length - 1],
            };
        }

        return {
            fullPath: dotSegments.join("/"),
            moduleName: dotSegments[dotSegments.length - 1],
        };
    }

    /**
     * The module name to put in front of a user, which for a relative import is
     * the whole dotted reference rather than its last segment: `HUD.Textures`
     * names the module more precisely than `Textures` does, and the lens has
     * room for it.
     */
    extractModuleName(importStatement: string): string | null {
        const result = this.extractModuleFromImport(importStatement);
        if (!result) return null;

        const pathStr = this.extractPathFromImport(importStatement);
        if (pathStr && !pathStr.startsWith("/")) return pathStr;
        return result.moduleName;
    }

    /**
     * Appends the locations where a folder of this name sits, searched outwards
     * from the current file: siblings first, then each ancestor directory, then
     * the Content root. A folder is an implicit module, so its presence is the
     * whole of the evidence.
     *
     * Nearest first, because a module is far likelier to be the one beside the
     * file importing it than a namesake elsewhere in the project.
     */
    private async searchImplicitModules(modulePath: string, currentFileUri: vscode.Uri, locations: string[]): Promise<void> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentFileUri);
        if (!workspaceFolder) return;

        const currentFilePath = path.relative(workspaceFolder.uri.fsPath, currentFileUri.fsPath).replace(/\\/g, "/");
        let currentFileDir = path.dirname(currentFilePath).replace(/\\/g, "/");

        const workspaceFolderName = path.basename(workspaceFolder.uri.fsPath);
        const workspaceFolderIsContent = workspaceFolderName === CONTENT_FOLDER;

        // Every path below is reasoned about with a leading Content/, so a
        // workspace opened at Content itself has that segment put back on.
        if (workspaceFolderIsContent) {
            currentFileDir = currentFileDir === "" || currentFileDir === "." ? CONTENT_FOLDER : `${CONTENT_FOLDER}/${currentFileDir}`;
        }

        if (!currentFileDir.startsWith(`${CONTENT_FOLDER}/`) && currentFileDir !== CONTENT_FOLDER) {
            return;
        }

        const dirSegments = currentFileDir.split("/");

        // The inverse of that: a filesystem check is made against the
        // workspace, which in this layout is already inside Content.
        const getFsCheckPath = (logicalPath: string): string => {
            if (workspaceFolderIsContent && logicalPath.startsWith(`${CONTENT_FOLDER}/`)) {
                return logicalPath.substring(CONTENT_FOLDER.length + 1);
            }
            return logicalPath;
        };

        // The file's own directory first, and nearest of all: a folder beside
        // the file is a member of the file's own module, which is what a bare
        // reference names from here - and what convertFromFullPath writes when
        // it shortens such a path. Without this the two directions stop being
        // inverses, and the shortest spelling is the one that cannot be read
        // back.
        const ownTestPath = `${currentFileDir}/${modulePath}`;
        if (await this.folderExists(workspaceFolder, getFsCheckPath(ownTestPath))) {
            const relativePath = currentFileDir === CONTENT_FOLDER ? "" : "/" + currentFileDir.substring(CONTENT_FOLDER.length + 1);
            if (!locations.includes(relativePath)) locations.push(relativePath);
        }

        if (dirSegments.length > 1) {
            const parentPath = dirSegments.slice(0, dirSegments.length - 1).join("/");
            const siblingTestPath = `${parentPath}/${modulePath}`;

            if (siblingTestPath.startsWith(`${CONTENT_FOLDER}/`)) {
                if (await this.folderExists(workspaceFolder, getFsCheckPath(siblingTestPath))) {
                    const relativePath = parentPath === CONTENT_FOLDER ? "" : "/" + parentPath.substring(CONTENT_FOLDER.length + 1);
                    if (!locations.includes(relativePath)) locations.push(relativePath);
                }
            }
        }

        for (let i = dirSegments.length - 2; i >= 0; i--) {
            const checkPath = dirSegments.slice(0, i + 1).join("/");
            const testPath = `${checkPath}/${modulePath}`;

            if (testPath.startsWith(`${CONTENT_FOLDER}/`)) {
                if (await this.folderExists(workspaceFolder, getFsCheckPath(testPath))) {
                    const relativePath = checkPath === CONTENT_FOLDER ? "" : "/" + checkPath.substring(CONTENT_FOLDER.length + 1);
                    if (!locations.includes(relativePath)) locations.push(relativePath);
                }
            }
        }

        const contentDirectChild = `${CONTENT_FOLDER}/${modulePath}`;
        if (await this.folderExists(workspaceFolder, getFsCheckPath(contentDirectChild))) {
            if (!locations.includes("")) locations.push("");
        }
    }

    /**
     * Where a workspace-wide `.verse` scan has to look, and whether the
     * workspace folder is itself the Content folder - which decides both the
     * glob and how a found path maps back to a Content-relative one.
     *
     * Shared by the two scanning phases so they cannot disagree about the
     * layout: a phase reading one rule and a phase reading the other would
     * resolve the same project differently.
     */
    private static workspaceScanTargets(workspaceFolder: { uri: vscode.Uri }): { searchPattern: string; workspaceIsContent: boolean } {
        const workspaceIsContent = path.basename(workspaceFolder.uri.fsPath) === CONTENT_FOLDER;
        return {
            searchPattern: workspaceIsContent ? "**/*.verse" : `${CONTENT_FOLDER}/**/*.verse`,
            workspaceIsContent,
        };
    }

    /**
     * Appends the locations of the `.verse` files explicitly declaring this
     * name as a module, which is the other way a module comes to exist and the
     * one no folder attests to.
     *
     * Capped at 100 files scanned, so a project larger than that resolves from
     * whichever of them the search returned.
     */
    private async searchExplicitModuleDefinitions(modulePath: string, moduleName: string, pathSegments: string[], locations: string[]): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;

        const { searchPattern, workspaceIsContent } = ImportPathConverter.workspaceScanTargets(workspaceFolders[0]);

        // Scope the scan to the project folder. The UEFN-generated workspace is
        // multi-root (Content plus Epic's digest folders); a bare string glob
        // would also read every *.digest.verse on each fallback scan.
        const verseFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolders[0], searchPattern), "**/*.digest.verse", 100);
        const modulePattern = ImportPathConverter.buildModuleDefinitionRegex(moduleName);

        for (const file of verseFiles) {
            const content = await vscode.workspace.fs.readFile(file).then(
                (buffer) => Buffer.from(buffer).toString("utf8"),
                () => null,
            );

            // Only a live declaration attests to a location. Matched against
            // raw text, a commented-out declaration or one quoted in a string
            // puts its directory into `locations`, which either makes the
            // conversion ambiguous or writes a path to the wrong file. The two
            // sibling scanners, moduleDeclarations and ProjectPathScanner, mask
            // for the same reason.
            if (!content || !modulePattern.test(maskCommentsAndStrings(content))) continue;

            logger.debug("ImportPathConverter", `Found module definition in: ${file.fsPath}`);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
            if (!workspaceFolder) continue;

            let relativePath = path.relative(workspaceFolder.uri.fsPath, file.fsPath).replace(/\\/g, "/");
            relativePath = path.dirname(relativePath).replace(/\\/g, "/");

            if (workspaceIsContent) {
                relativePath = relativePath === "" || relativePath === "." ? CONTENT_FOLDER : `${CONTENT_FOLDER}/${relativePath}`;
            }

            if (!relativePath.startsWith(CONTENT_FOLDER)) continue;

            relativePath = relativePath.startsWith(`${CONTENT_FOLDER}/`) ? relativePath.substring(CONTENT_FOLDER.length + 1) : relativePath === CONTENT_FOLDER ? "" : relativePath;

            // A dotted reference names the path to the module as well as the
            // module, and only the last segment was searched for, so a
            // declaration whose directory does not end in the rest of the
            // reference declares a different module of the same name.
            if (pathSegments.length > 1) {
                const parentPath = pathSegments.slice(0, -1).join("/");
                if (!relativePath.endsWith(parentPath)) continue;

                relativePath = relativePath.substring(0, relativePath.length - parentPath.length);
                if (relativePath.endsWith("/")) relativePath = relativePath.substring(0, relativePath.length - 1);
            }

            if (!relativePath.startsWith("/") && relativePath !== "") relativePath = "/" + relativePath;

            if (!locations.includes(relativePath)) {
                locations.push(relativePath);
            }
        }
    }

    /**
     * Appends the locations of folder modules anywhere in the project, which
     * searchImplicitModules reaches only near the current file and the
     * declaration scan cannot see at all - a folder module has no declaration
     * to match, so a chain like Systems/Combat/Weapons is invisible to every
     * other phase from an unrelated branch of the tree.
     *
     * Folders are derived from the paths of the project's `.verse` files, never
     * from their contents, so this reads no file. The blind spot that leaves is
     * a folder holding no `.verse` file anywhere beneath it; such a module has
     * no members to import, so nothing would name it.
     *
     * Capped at FOLDER_SCAN_FILE_LIMIT files enumerated.
     */
    private async searchProjectFolderModules(modulePath: string, locations: string[]): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;

        const { searchPattern, workspaceIsContent } = ImportPathConverter.workspaceScanTargets(workspaceFolders[0]);
        const verseFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolders[0], searchPattern), "**/*.digest.verse", FOLDER_SCAN_FILE_LIMIT);

        const contentRelativeDirs = new Set<string>();
        for (const file of verseFiles) {
            const workspaceRelative = path.relative(workspaceFolders[0].uri.fsPath, file.fsPath).replace(/\\/g, "/");
            const directory = toContentRelativeDir(workspaceRelative, workspaceIsContent);

            // null is a file outside Content, which contributes no importable
            // module.
            if (directory !== null) contentRelativeDirs.add(directory);
        }

        for (const location of resolveFolderModuleLocations(modulePath, contentRelativeDirs)) {
            if (!locations.includes(location)) locations.push(location);
        }
    }

    /**
     * Every place in the workspace the module could be, as locations relative
     * to the Content root: "" for the root itself, "/Dir/Sub" below it. Empty
     * when the module is nowhere to be found, and longer than one entry when
     * the name is ambiguous.
     *
     * Three searches, each running only if the ones before it found nothing: a
     * folder near the current file (searchImplicitModules), then an explicit
     * declaration anywhere in the project (searchExplicitModuleDefinitions),
     * then a folder module anywhere in the project
     * (searchProjectFolderModules).
     *
     * Ordered by how well each answers "which module was meant". Proximity
     * comes first, being the strongest signal of intent. A declaration
     * outranks a distant folder because it names the module outright, where a
     * folder chain across the project is positional evidence alone - which is
     * also why the last phase is the likeliest of the three to come back with
     * several candidates rather than one.
     *
     * The last phase is the compiler's own recovery for this failure: where the
     * scope walk resolves nothing, it searches every module in the program and
     * collects all the matches rather than the first, which is why an ambiguous
     * answer here is a result and not a fault.
     */
    async findModuleLocations(modulePath: string, currentFileUri?: vscode.Uri): Promise<string[]> {
        const locations: string[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return locations;

        const pathSegments = modulePath.split("/").filter((s) => s);
        const moduleName = pathSegments[pathSegments.length - 1];

        logger.debug("ImportPathConverter", `Searching for module '${modulePath}'`);

        if (currentFileUri) {
            try {
                await this.searchImplicitModules(modulePath, currentFileUri, locations);
            } catch (error) {
                logger.debug("ImportPathConverter", `Error in Phase 1 (implicit modules): ${error}`);
            }
        }

        // The cache stands in for the declaration search, never above it: every
        // candidate is checked against the filesystem before it is trusted, and
        // the full scan below still runs whenever the cache yields nothing
        // valid - empty, stale, or never set.
        if (locations.length === 0 && this.projectPathCache) {
            const candidates = this.projectPathCache.lookupModuleLocations(modulePath);
            for (const candidate of candidates) {
                if (locations.includes(candidate.location)) {
                    continue;
                }
                if (await this.sourceFileExists(workspaceFolders[0], candidate.sourceFile)) {
                    locations.push(candidate.location);
                } else {
                    logger.debug("ImportPathConverter", `Cache candidate rejected, missing file: ${candidate.sourceFile}`);
                }
            }
            if (locations.length > 0) {
                logger.debug("ImportPathConverter", `Found ${locations.length} validated location(s) from cache for '${modulePath}'`);
            }
        }

        if (locations.length === 0) {
            logger.debug("ImportPathConverter", `Phase 2: Searching explicit module definitions`);
            try {
                await this.searchExplicitModuleDefinitions(modulePath, moduleName, pathSegments, locations);
            } catch (error) {
                logger.debug("ImportPathConverter", `Error in Phase 2 (explicit modules): ${error}`);
            }
        }

        if (locations.length === 0) {
            logger.debug("ImportPathConverter", `Phase 3: Searching folder modules across the project`);
            try {
                await this.searchProjectFolderModules(modulePath, locations);
            } catch (error) {
                logger.debug("ImportPathConverter", `Error in Phase 3 (project folder modules): ${error}`);
            }
        }

        logger.debug("ImportPathConverter", `Module search complete for '${modulePath}'`);
        logger.debug("ImportPathConverter", `Found ${locations.length} possible locations:`);
        if (locations.length > 0) {
            locations.forEach((loc) => logger.debug("ImportPathConverter", `  - Location: '${loc}' (${loc === "" ? "root/Content" : loc})`));
        } else {
            logger.debug("ImportPathConverter", `  - No locations found!`);
        }

        return locations;
    }

    /** Path segments with the leading slash and any empty segments dropped. */
    private static splitPath(versePath: string): string[] {
        return versePath.split("/").filter((segment) => segment);
    }

    /**
     * How many leading segments two paths share, comparing the first
     * `foldSegments` of them folded ASCII-only and every segment after that
     * byte-exact.
     *
     * The fold is bounded because the two halves of a Verse path answer to
     * different rules. The project prefix is not resolved by anything: it names
     * the package, and the same package reaches this code spelled two ways -
     * one from the `.uefnproject`, one from a compiler diagnostic - so folding
     * it absorbs a drift that is not a difference. Every segment below the
     * prefix is a module name the compiler resolves byte-exact, so `Shop` and
     * `shop` there are two modules, and folding them names the wrong one.
     *
     * Epic folds the whole path (ConvertFullVersePathToRelativeDotSyntax), but
     * only ever for a definition it has already resolved in the same package,
     * so the fold never has to be right about which module a segment names.
     *
     * Segments are compared whole, a deliberate divergence: Epic walks
     * characters and, when one path runs out inside the other's segment, ends
     * the common part mid-label, so `/proj/Economy/Shop` against a scope at
     * `/proj/Econ` yields `omy.Shop` there.
     */
    private static sharedSegmentCount(pathSegments: string[], baseSegments: string[], foldSegments: number): number {
        const foldAscii = (segment: string): string => segment.replace(/[a-z]/g, (character) => character.toUpperCase());

        let common = 0;
        while (common < pathSegments.length && common < baseSegments.length) {
            const matches = common < foldSegments ? foldAscii(pathSegments[common]) === foldAscii(baseSegments[common]) : pathSegments[common] === baseSegments[common];
            if (!matches) break;
            common++;
        }

        return common;
    }

    /**
     * Whether two absolute Verse paths name the same module, under the same
     * prefix rule sharedSegmentCount applies.
     *
     * Needed because the two paths reaching the round-trip check are spelled by
     * different sources: the rebuilt one carries the `.uefnproject` prefix and
     * the one from the document carries whatever the author wrote.
     */
    private static namesSameModule(pathA: string, pathB: string, foldSegments: number): boolean {
        const segmentsA = ImportPathConverter.splitPath(pathA);
        const segmentsB = ImportPathConverter.splitPath(pathB);

        return segmentsA.length === segmentsB.length && ImportPathConverter.sharedSegmentCount(segmentsA, segmentsB, foldSegments) === segmentsA.length;
    }

    /**
     * The dotted reference naming `fullPath` from a scope at `basePath`: the
     * segments left after the longest prefix the two paths share, joined with
     * ".". Empty when nothing is left, which is a path naming the base itself.
     *
     * @param foldSegments how many leading segments are the project prefix, the
     *   only part compared case-insensitively
     */
    private static relativizeAgainst(fullPath: string, basePath: string, foldSegments: number): string {
        const fullSegments = ImportPathConverter.splitPath(fullPath);
        const common = ImportPathConverter.sharedSegmentCount(fullSegments, ImportPathConverter.splitPath(basePath), foldSegments);

        return fullSegments.slice(common).join(".");
    }

    /**
     * The absolute Verse path of the folder module a file sits in, or null when
     * the file is not under a Content root this project addresses.
     *
     * The directory is the whole of the evidence, a folder being an implicit
     * module. Only the folder chain is read, so a `using` written inside a
     * nested `module { }` block in the file is placed at the file's own scope
     * rather than the block's - a longer reference than the compiler would
     * name, and one that still resolves, since resolution walks the parent
     * chain outward.
     */
    private enclosingModulePath(documentUri: vscode.Uri, projectVersePath: string): string | null {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!workspaceFolder) return null;

        const relativeFilePath = path.relative(workspaceFolder.uri.fsPath, documentUri.fsPath).replace(/\\/g, "/");
        let fileDir = path.dirname(relativeFilePath).replace(/\\/g, "/");

        // Every path below is reasoned about with a leading Content/, so a
        // workspace opened at Content itself has that segment put back on -
        // the same correction searchImplicitModules makes.
        if (path.basename(workspaceFolder.uri.fsPath) === CONTENT_FOLDER) {
            fileDir = fileDir === "" || fileDir === "." ? CONTENT_FOLDER : `${CONTENT_FOLDER}/${fileDir}`;
        }

        if (fileDir === CONTENT_FOLDER) return projectVersePath;
        if (!fileDir.startsWith(`${CONTENT_FOLDER}/`)) return null;

        return `${projectVersePath}/${fileDir.substring(CONTENT_FOLDER.length + 1)}`;
    }

    /**
     * Whether `reference`, written in the file at `documentUri`, names the
     * module `fullPath` names.
     *
     * Only the reference's first segment is looked up, because only that
     * segment is resolved through the scope chain: the compiler walks the
     * importing scope's parents collecting a match at every level, then
     * descends the segments after it byte-exact from whichever match it takes.
     * So a nearer module of that name decides the whole reference, and one that
     * does not carry the rest of the chain breaks a reference whose full chain
     * exists elsewhere - which is why matching the whole chain would confirm a
     * spelling the compiler cannot read.
     *
     * Anything but one location refuses. Two or more mean a nearer namesake
     * shadows the target or clashes with it, and no relative spelling reaches
     * past it, so there is no conversion to offer rather than a longer one to
     * find. None means nothing here can place the module, which is exactly the
     * position this check exists to stop a conversion being written from.
     */
    private async referenceResolvesTo(reference: string, fullPath: string, documentUri: vscode.Uri | undefined, projectVersePath: string): Promise<boolean> {
        const referenceSegments = reference.split(".");
        const firstSegment = referenceSegments[0];
        const fullSegments = ImportPathConverter.splitPath(fullPath);

        // The first segment names the path with one segment dropped for each
        // segment written after it.
        const expectedPath = `/${fullSegments.slice(0, fullSegments.length - (referenceSegments.length - 1)).join("/")}`;

        const locations = await this.findModuleLocations(firstSegment, documentUri);
        if (locations.length !== 1) {
            logger.debug("ImportPathConverter", `Refusing '${reference}' for ${fullPath}: '${firstSegment}' resolves to ${locations.length} locations, not one`);
            return false;
        }

        const resolved = ImportPathConverter.buildFullVersePath(projectVersePath, locations[0], firstSegment);
        if (!ImportPathConverter.namesSameModule(resolved, expectedPath, ImportPathConverter.splitPath(projectVersePath).length)) {
            logger.debug("ImportPathConverter", `Refusing '${reference}' for ${fullPath}: '${firstSegment}' resolves to ${resolved}, not ${expectedPath}`);
            return false;
        }

        return true;
    }

    /**
     * The relative form of an absolute import, in the style the author wrote,
     * or null when there is none to give: a built-in module, an import that
     * was never absolute, a workspace with no `.uefnproject` to take the
     * project path from, or a path that shortens to nothing.
     *
     * Shortened against the module the importing file sits in, which is the
     * dialect the compiler speaks: its own suggestions arrive spelled that way
     * and are written as imports, so a second dialect here would put one module
     * in a file under two spellings, and the presence check compares spellings.
     *
     * Never ambiguous, because one scope shortens one import exactly one way.
     * The other direction has a whole workspace of candidate locations to
     * choose between.
     *
     * Shortening is proposed, not trusted: the reference is resolved back
     * through the same workspace search the other direction uses, and a
     * reference that does not name the module the absolute path named is
     * refused. Refusing is the only safe answer available - the conversion
     * writes over an import that compiles today, so a spelling this cannot
     * confirm would trade a working import for a broken or a silently
     * different one.
     *
     * @param documentUri The file the import is written in. Without it the
     *   project root stands in as the scope, which is what shortens an import
     *   when the file cannot be placed under Content.
     */
    async convertFromFullPath(importStatement: string, documentUri?: vscode.Uri, line?: number): Promise<ImportConversionResult | null> {
        if (this.isBuiltinModule(importStatement)) {
            logger.debug("ImportPathConverter", "Cannot convert built-in module to relative path");
            return null;
        }

        if (!this.isFullPathImport(importStatement)) {
            logger.debug("ImportPathConverter", "Import is not in full path format");
            return null;
        }

        // Read through extractPathFromImport rather than a second copy of its
        // patterns, so the trailing-comment strip cannot be left out of the
        // copy: applyConversion restores the comment itself, so one left in the
        // path is written twice.
        const fullPath = this.extractPathFromImport(importStatement);

        if (!fullPath || !fullPath.startsWith("/")) {
            return null;
        }

        const projectVersePath = await this.projectPathHandler.getProjectVersePath();
        if (!projectVersePath) {
            return null;
        }

        const projectSegments = ImportPathConverter.splitPath(projectVersePath);

        // A path the project does not contain has no relative form from inside
        // it, whatever prefix the two happen to share. Shortening one anyway
        // emits a first segment that either cannot lex - `@` is not an Ident
        // character, so a foreign account's segment is a parse error - or names
        // whatever local module happens to answer to it. Both replace a broken
        // import with a differently broken one that can no longer be converted
        // back.
        if (ImportPathConverter.sharedSegmentCount(ImportPathConverter.splitPath(fullPath), projectSegments, projectSegments.length) < projectSegments.length) {
            logger.debug("ImportPathConverter", `Cannot shorten a path outside the project: ${fullPath}`);
            return null;
        }

        const scopePath = (documentUri && this.enclosingModulePath(documentUri, projectVersePath)) || projectVersePath;
        const shortened = ImportPathConverter.relativizeAgainst(fullPath, scopePath, projectSegments.length);

        // Nothing left over means the target is the importing file's own module
        // or an ancestor of it. The module still has a name, and whatever
        // encloses it encloses the file too, so the bare name reaches it - the
        // construction Epic uses, which shortens the definition's parent and
        // appends the definition's own name. The project root is the one target
        // this does not hold for: what encloses it is the registry rather than
        // a scope the file sits in. That test shortens against the root rather
        // than comparing prefixes, so both halves fold case the same way.
        const belowProjectRoot = ImportPathConverter.relativizeAgainst(fullPath, projectVersePath, projectSegments.length);
        const relativeImportPath = shortened || (belowProjectRoot ? fullPath.substring(fullPath.lastIndexOf("/") + 1) : "");

        if (!relativeImportPath) {
            logger.debug("ImportPathConverter", "Could not extract relative path from full path");
            return null;
        }

        if (!(await this.referenceResolvesTo(relativeImportPath, fullPath, documentUri, projectVersePath))) {
            return null;
        }

        const modulePathSegments = relativeImportPath.split(".");

        const usesCurlyBraces = ImportPathConverter.usesBracedStyle(importStatement);
        const relativeImport = usesCurlyBraces ? `using { ${relativeImportPath} }` : `using. ${relativeImportPath}`;

        return {
            originalImport: importStatement,
            convertedImport: relativeImport,
            moduleName: modulePathSegments[modulePathSegments.length - 1],
            isAmbiguous: false,
            line,
        };
    }

    /**
     * A conversion for each absolute import in a document that has a relative
     * form, in the order the lines run. Built-in modules and imports already
     * relative contribute nothing.
     */
    async convertAllImportsFromFullPath(document: vscode.TextDocument): Promise<ImportConversionResult[]> {
        const results: ImportConversionResult[] = [];
        const text = document.getText();
        const lines = text.split(LINE_SPLIT);

        for (const { statement, line } of scanConvertibleImports(lines)) {
            if (this.isFullPathImport(statement) && !this.isBuiltinModule(statement)) {
                const result = await this.convertFromFullPath(statement, document.uri, line);
                if (result) {
                    results.push(result);
                }
            }
        }

        return results;
    }

    /**
     * The absolute form of a relative import, in the style the author wrote,
     * or null when there is none to give: an import that is already absolute,
     * one naming no module at all, a workspace with no `.uefnproject` to take
     * the project path from, or a module the search cannot place.
     *
     * The last two also put a message in front of the user, since a lookup that
     * came back empty is a request that failed rather than one that did not
     * apply.
     *
     * A module resolving to several locations comes back `isAmbiguous`, with
     * the candidates in `possiblePaths` and no statement built yet - the caller
     * picks, then hands the choice to applyConversion.
     */
    async convertToFullPath(importStatement: string, documentUri: vscode.Uri, line?: number): Promise<ImportConversionResult | null> {
        if (this.isFullPathImport(importStatement)) {
            if (this.isBuiltinModule(importStatement)) {
                logger.debug("ImportPathConverter", "Import is a built-in module and should not be converted");
            } else {
                logger.debug("ImportPathConverter", "Import is already in full path format");
            }
            return null;
        }

        const moduleInfo = this.extractModuleFromImport(importStatement);
        if (!moduleInfo) {
            logger.debug("ImportPathConverter", "Could not extract module info from import");
            return null;
        }

        const { fullPath: modulePath, moduleName } = moduleInfo;

        const projectVersePath = await this.projectPathHandler.getProjectVersePath();
        if (!projectVersePath) {
            vscode.window.showWarningMessage("Could not find .uefnproject file in workspace. Please ensure you have a valid UEFN project.");
            return null;
        }

        logger.debug("ImportPathConverter", `Project verse path: ${projectVersePath}`);

        const possibleLocations = await this.findModuleLocations(modulePath, documentUri);
        logger.debug("ImportPathConverter", `findModuleLocations returned ${possibleLocations.length} location(s)`);
        possibleLocations.forEach((loc, idx) => logger.debug("ImportPathConverter", `  Location ${idx}: '${loc}'`));

        const usesCurlyBraces = ImportPathConverter.usesBracedStyle(importStatement);

        if (possibleLocations.length === 0) {
            logger.debug("ImportPathConverter", `No locations found for ${modulePath}`);
            vscode.window.showErrorMessage(`Could not find module '${moduleName}'. Please verify the module exists and is properly defined.`);
            return null;
        } else if (possibleLocations.length === 1) {
            const location = possibleLocations[0];
            logger.debug("ImportPathConverter", `Single location found: '${location}'`);

            const fullPath = ImportPathConverter.buildFullVersePath(projectVersePath, location, modulePath);
            logger.debug("ImportPathConverter", `Constructed full path: ${fullPath}`);

            const convertedImport = usesCurlyBraces ? `using { ${fullPath} }` : `using. ${fullPath}`;

            return {
                originalImport: importStatement,
                convertedImport,
                moduleName,
                isAmbiguous: false,
                line,
            };
        } else {
            const possiblePaths = possibleLocations.map((location) => ImportPathConverter.buildFullVersePath(projectVersePath, location, modulePath));

            return {
                originalImport: importStatement,
                convertedImport: "",
                moduleName,
                isAmbiguous: true,
                possiblePaths,
                line,
            };
        }
    }

    /**
     * A conversion for each relative import in a document, in the order the
     * lines run. Any of them may be ambiguous, so a caller applying the whole
     * set has a choice to put to the user for each one.
     */
    async convertAllImportsToFullPath(document: vscode.TextDocument): Promise<ImportConversionResult[]> {
        const results: ImportConversionResult[] = [];
        const text = document.getText();
        const lines = text.split(LINE_SPLIT);

        for (const { statement, line } of scanConvertibleImports(lines)) {
            const result = await this.convertToFullPath(statement, document.uri, line);
            if (result) {
                results.push(result);
            }
        }

        return results;
    }

    /**
     * The line a conversion must land on.
     *
     * The line the caller recorded wins, because statement text is not unique in
     * a document: an identical `using` can sit in a `<# ... #>` block comment or
     * be plainly repeated above the one the user acted on, and the first textual
     * match is then the wrong line. Only that recorded line is checked against
     * the statement, never searched for, so a duplicate above it cannot win.
     *
     * A search remains for a caller with no line to give, and for a line that no
     * longer holds the statement because the document changed while the
     * conversion was being resolved - resolving one spans a workspace scan, and
     * an ambiguous one also spans a quick pick. That search goes through the
     * shared scanner rather than every line, so the fallback can only land where
     * a lens would have appeared.
     *
     * Comparison is by trimmed text, so the recorded line still matches after
     * the user indents or outdents the import while the conversion resolves.
     */
    private static findConversionLine(lines: string[], conversion: ImportConversionResult): number {
        const original = conversion.originalImport.trim();
        const recorded = conversion.line;

        if (recorded !== undefined && recorded >= 0 && recorded < lines.length && lines[recorded].trim() === original) {
            return recorded;
        }

        return scanConvertibleImports(lines).find(({ statement }) => statement === original)?.line ?? -1;
    }

    /**
     * Writes a conversion over the line it came from, keeping that line's
     * indentation and trailing comment. False when the line is no longer
     * findable or the edit is refused.
     *
     * @param selectedPath The path chosen for an ambiguous conversion. Without
     *   it such a conversion writes its empty statement, erasing the import.
     */
    async applyConversion(document: vscode.TextDocument, conversion: ImportConversionResult, selectedPath?: string): Promise<boolean> {
        const text = document.getText();
        const lines = text.split(LINE_SPLIT);
        const lineIndex = ImportPathConverter.findConversionLine(lines, conversion);

        if (lineIndex === -1) {
            logger.debug("ImportPathConverter", `Could not find import line: ${conversion.originalImport}`);
            return false;
        }

        let finalImport = conversion.convertedImport;
        if (conversion.isAmbiguous && selectedPath) {
            const usesCurlyBraces = ImportPathConverter.usesBracedStyle(conversion.originalImport);
            finalImport = usesCurlyBraces ? `using { ${selectedPath} }` : `using. ${selectedPath}`;
        }

        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(new vscode.Position(lineIndex, 0), new vscode.Position(lineIndex, lines[lineIndex].length));

        // The replacement is built from the statement alone, so everything else
        // the line carried is dropped unless it is put back. The comment is read
        // from the line about to be replaced, which is the text this edit
        // overwrites - the conversion carries the same comment, since
        // findConversionLine matches on the whole trimmed line, so reading it
        // here is the one that needs no field threaded through ConvertibleImport
        // and ImportConversionResult to reach this point.
        //
        // Only the annotation is at stake here. An import whose line opens a
        // comment over the lines below it never reaches this point, because
        // scanConvertibleImports excludes it; see ScannedImport.anchorsCommentBelow.
        const originalIndent = lines[lineIndex].match(/^\s*/)?.[0] || "";
        const trailingComment = ImportFormatter.extractTrailingComment(lines[lineIndex]);
        const rebuiltLine = trailingComment ? `${finalImport} ${trailingComment}` : finalImport;
        edit.replace(document.uri, range, originalIndent + rebuiltLine);

        try {
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                logger.debug("ImportPathConverter", `Converted: ${conversion.originalImport} -> ${finalImport}`);
            } else {
                logger.debug("ImportPathConverter", `Failed to apply conversion for: ${conversion.originalImport}`);
            }
            return success;
        } catch (error) {
            logger.debug("ImportPathConverter", `Error applying conversion: ${error}`);
            return false;
        }
    }
}

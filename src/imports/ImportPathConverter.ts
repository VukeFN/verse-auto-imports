import * as vscode from "vscode";
import * as path from "path";
import { logger } from "../utils";
import { ProjectPathHandler } from "../project";
import { ProjectPathCache } from "../services";
import { ImportFormatter } from "./ImportFormatter";
import { scanConvertibleImports } from "./ImportScanner";

interface ImportConversionResult {
    originalImport: string;
    fullPathImport: string;
    moduleName: string;
    isAmbiguous: boolean;
    possiblePaths?: string[];
    /**
     * The line the conversion acts on, where the caller knows it. Statement text
     * is not unique in a document, so this is what keeps the edit on the line the
     * user chose rather than on the first line that reads the same.
     */
    line?: number;
}

/** Content folder name constant */
const CONTENT_FOLDER = "Content";

export class ImportPathConverter {
    private readonly projectPathHandler: ProjectPathHandler;
    private projectPathCache: ProjectPathCache | null = null;

    constructor(
        private readonly outputChannel: vscode.OutputChannel,
        projectPathCache?: ProjectPathCache,
    ) {
        this.projectPathHandler = new ProjectPathHandler(outputChannel);
        this.projectPathCache = projectPathCache || null;
    }

    /**
     * Set the project path cache for faster lookups.
     */
    setProjectPathCache(cache: ProjectPathCache): void {
        this.projectPathCache = cache;
    }

    /**
     * Helper function to check if a folder exists in the workspace
     */
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

    /** Checks whether a workspace-relative file still exists (guards against stale cache entries) */
    private async sourceFileExists(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): Promise<boolean> {
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder.uri, relativePath));
            return stat.type === vscode.FileType.File;
        } catch {
            return false;
        }
    }

    /**
     * Builds the absolute Verse path for a module resolved at a location.
     * `location` follows the location contract ("" or "/Dir/Sub" relative to
     * the Content root); `modulePath` uses "/" separators.
     */
    static buildFullVersePath(projectVersePath: string, location: string, modulePath: string): string {
        return location === "/" || location === "" ? `${projectVersePath}/${modulePath}` : `${projectVersePath}${location}/${modulePath}`;
    }

    /**
     * Builds a regex matching an explicit `Name := module:` declaration for the
     * given module name. Non-global on purpose: this pattern is reused with
     * `.test()` across many files, and a global flag would carry `lastIndex`
     * between calls and skip valid definitions depending on file order.
     */
    static buildModuleDefinitionRegex(moduleName: string): RegExp {
        const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}(?:'[^']*')?\\s*(?:<\\s*(?:public|private|internal|protected)\\s*>)?\\s*:=\\s*module\\s*[:>]`, "m");
    }

    /**
     * Extracts the path string from an import statement, minus any trailing comment.
     *
     * Anchored on the trimmed statement, and dotted before braced, to match
     * ImportFormatter. Unanchored, the braced pattern is free to match inside
     * the trailing comment of a dotted statement and win the path - which
     * misclassifies the import through isFullPathImport and isBuiltinModule as
     * well as converting the wrong module.
     */
    private extractPathFromImport(importStatement: string): string {
        const trimmed = importStatement.trim();
        const dotMatch = trimmed.match(/^using\.\s*(.+)/);
        const curlyMatch = dotMatch ? null : trimmed.match(/^using\s*\{\s*([^}]+)\s*\}/);
        const captured = dotMatch ? dotMatch[1] : curlyMatch ? curlyMatch[1] : "";
        return ImportFormatter.stripTrailingComment(captured);
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

    /** Checks if an import is already in full path format */
    isFullPathImport(importStatement: string): boolean {
        const path = this.extractPathFromImport(importStatement);
        return path.startsWith("/") || path.includes("@fortnite.com");
    }

    /** Checks if an import is a built-in module from Fortnite.com, UnrealEngine.com, or Verse.org */
    isBuiltinModule(importStatement: string): boolean {
        const path = this.extractPathFromImport(importStatement);
        return path.startsWith("/Fortnite.com/") || path.startsWith("/UnrealEngine.com/") || path.startsWith("/Verse.org/");
    }

    /** Extracts the module path and name from an import statement */
    extractModuleFromImport(importStatement: string): { fullPath: string; moduleName: string } | null {
        const pathStr = this.extractPathFromImport(importStatement);
        if (!pathStr) return null;

        // Full path format - extract last segment
        if (pathStr.startsWith("/")) {
            const segments = pathStr.split("/").filter((s) => s);
            const lastSegment = segments[segments.length - 1];
            const moduleName = lastSegment.includes("@") ? lastSegment.split("@")[0] : lastSegment;
            return { fullPath: pathStr, moduleName };
        }

        // Dot notation (e.g., HUD.Textures -> HUD/Textures)
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

    /** Returns module name for display (shows full dot notation for relative imports) */
    extractModuleName(importStatement: string): string | null {
        const result = this.extractModuleFromImport(importStatement);
        if (!result) return null;

        const pathStr = this.extractPathFromImport(importStatement);
        // For relative imports, show full path as-is for display
        if (pathStr && !pathStr.startsWith("/")) return pathStr;
        return result.moduleName;
    }

    /** Parses explicit module definitions from Verse file content */
    parseExplicitModuleDefinition(content: string): string[] {
        const modules: string[] = [];
        const moduleDefPattern = /\b([A-Za-z_][A-Za-z0-9_]*(?:'[^']*')?)\s*(?:<\s*(?:public|private|internal|protected)\s*>)?\s*:=\s*module\s*[:>]/gm;
        let match;
        while ((match = moduleDefPattern.exec(content)) !== null) {
            modules.push(match[1]);
        }
        return modules;
    }

    /**
     * Phase 1: Search for folders (implicit modules) relative to the current file.
     * Searches sibling folders, ascending directories, and Content root.
     */
    private async searchImplicitModules(modulePath: string, currentFileUri: vscode.Uri, locations: string[]): Promise<void> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentFileUri);
        if (!workspaceFolder) return;

        const currentFilePath = path.relative(workspaceFolder.uri.fsPath, currentFileUri.fsPath).replace(/\\/g, "/");
        let currentFileDir = path.dirname(currentFilePath).replace(/\\/g, "/");

        // Check if workspace IS the Content folder
        const workspaceFolderName = path.basename(workspaceFolder.uri.fsPath);
        const workspaceFolderIsContent = workspaceFolderName === CONTENT_FOLDER;

        // Normalize paths when workspace IS Content
        if (workspaceFolderIsContent) {
            currentFileDir = currentFileDir === "" || currentFileDir === "." ? CONTENT_FOLDER : `${CONTENT_FOLDER}/${currentFileDir}`;
        }

        if (!currentFileDir.startsWith(`${CONTENT_FOLDER}/`) && currentFileDir !== CONTENT_FOLDER) {
            return;
        }

        const dirSegments = currentFileDir.split("/");

        // Helper to adjust path for filesystem checks
        const getFsCheckPath = (logicalPath: string): string => {
            if (workspaceFolderIsContent && logicalPath.startsWith(`${CONTENT_FOLDER}/`)) {
                return logicalPath.substring(CONTENT_FOLDER.length + 1);
            }
            return logicalPath;
        };

        // Check sibling modules
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

        // Ascending directory traversal
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

        // Check direct Content children
        const contentDirectChild = `${CONTENT_FOLDER}/${modulePath}`;
        if (await this.folderExists(workspaceFolder, getFsCheckPath(contentDirectChild))) {
            if (!locations.includes("")) locations.push("");
        }
    }

    /**
     * Phase 2: Search for explicit module definitions in .verse files.
     * Scans the project folder for files containing Name := module declarations.
     */
    private async searchExplicitModuleDefinitions(modulePath: string, moduleName: string, pathSegments: string[], locations: string[]): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;

        let searchPattern = `${CONTENT_FOLDER}/**/*.verse`;
        const workspaceFolderName = path.basename(workspaceFolders[0].uri.fsPath);
        const workspaceIsContent = workspaceFolderName === CONTENT_FOLDER;
        if (workspaceIsContent) searchPattern = "**/*.verse";

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

            if (!content || !modulePattern.test(content)) continue;

            logger.debug("ImportPathConverter", `Found module definition in: ${file.fsPath}`);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
            if (!workspaceFolder) continue;

            let relativePath = path.relative(workspaceFolder.uri.fsPath, file.fsPath).replace(/\\/g, "/");
            relativePath = path.dirname(relativePath).replace(/\\/g, "/");

            // Normalize path when workspace IS Content
            if (workspaceIsContent) {
                relativePath = relativePath === "" || relativePath === "." ? CONTENT_FOLDER : `${CONTENT_FOLDER}/${relativePath}`;
            }

            if (!relativePath.startsWith(CONTENT_FOLDER)) continue;

            // Remove Content prefix
            relativePath = relativePath.startsWith(`${CONTENT_FOLDER}/`) ? relativePath.substring(CONTENT_FOLDER.length + 1) : relativePath === CONTENT_FOLDER ? "" : relativePath;

            // For nested paths, verify parent path matches
            if (pathSegments.length > 1) {
                const parentPath = pathSegments.slice(0, -1).join("/");
                if (!relativePath.endsWith(parentPath)) continue;

                relativePath = relativePath.substring(0, relativePath.length - parentPath.length);
                if (relativePath.endsWith("/")) relativePath = relativePath.substring(0, relativePath.length - 1);
            }

            // Format path
            if (!relativePath.startsWith("/") && relativePath !== "") relativePath = "/" + relativePath;

            if (!locations.includes(relativePath)) {
                locations.push(relativePath);
            }
        }
    }

    /** Scans the workspace for possible locations of a module */
    async findModuleLocations(modulePath: string, currentFileUri?: vscode.Uri): Promise<string[]> {
        const locations: string[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return locations;

        const pathSegments = modulePath.split("/").filter((s) => s);
        const moduleName = pathSegments[pathSegments.length - 1];

        logger.debug("ImportPathConverter", `Searching for module '${modulePath}'`);

        // Phase 1: Search for folders (implicit modules) in Content folder.
        // This runs first because it is locality-aware (prefers modules near
        // the current file) and folder modules are filesystem-only knowledge
        // that the declaration cache cannot provide.
        if (currentFileUri) {
            try {
                await this.searchImplicitModules(modulePath, currentFileUri, locations);
            } catch (error) {
                logger.debug("ImportPathConverter", `Error in Phase 1 (implicit modules): ${error}`);
            }
        }

        // Phase 2: Explicit module definitions. The cache accelerates this
        // phase; every candidate is validated against the filesystem before
        // being trusted, and the full scan still runs when the cache has
        // nothing valid (empty, stale, or disabled).
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

        logger.debug("ImportPathConverter", `Module search complete for '${modulePath}'`);
        logger.debug("ImportPathConverter", `Found ${locations.length} possible locations:`);
        if (locations.length > 0) {
            locations.forEach((loc) => logger.debug("ImportPathConverter", `  - Location: '${loc}' (${loc === "" ? "root/Content" : loc})`));
        } else {
            logger.debug("ImportPathConverter", `  - No locations found!`);
        }

        return locations;
    }

    /**
     * Converts a full path import to a relative import
     */
    async convertFromFullPath(importStatement: string, line?: number): Promise<ImportConversionResult | null> {
        if (this.isBuiltinModule(importStatement)) {
            logger.debug("ImportPathConverter", "Cannot convert built-in module to relative path");
            return null;
        }

        if (!this.isFullPathImport(importStatement)) {
            logger.debug("ImportPathConverter", "Import is not in full path format");
            return null;
        }

        // Read through extractPathFromImport rather than a second copy of its
        // regexes, because that copy skipped the trailing-comment strip: the
        // dotted capture runs to end of line, so `using. /A/B # note` yielded the
        // path `/A/B # note` and re-emitted the comment inside the converted
        // statement - which applyConversion, restoring the comment itself, would
        // then write a second time.
        const fullPath = this.extractPathFromImport(importStatement);

        if (!fullPath || !fullPath.startsWith("/")) {
            return null;
        }

        const projectVersePath = await this.projectPathHandler.getProjectVersePath();
        if (!projectVersePath) {
            return null;
        }

        let relativePath = fullPath;

        if (fullPath.startsWith(projectVersePath + "/")) {
            relativePath = fullPath.substring(projectVersePath.length + 1);
        } else if (fullPath === projectVersePath) {
            relativePath = "";
        }

        const modulePathSegments = relativePath.split("/").filter((s) => s);
        const relativeImportPath = modulePathSegments.join(".");

        if (!relativeImportPath) {
            logger.debug("ImportPathConverter", "Could not extract relative path from full path");
            return null;
        }

        const usesCurlyBraces = ImportPathConverter.usesBracedStyle(importStatement);
        const relativeImport = usesCurlyBraces ? `using { ${relativeImportPath} }` : `using. ${relativeImportPath}`;

        return {
            originalImport: importStatement,
            fullPathImport: relativeImport, // In this case, it's actually the relative import
            moduleName: modulePathSegments[modulePathSegments.length - 1] || relativeImportPath,
            isAmbiguous: false,
            line,
        };
    }

    /**
     * Converts all full path imports in a document to relative imports
     */
    async convertAllImportsFromFullPath(document: vscode.TextDocument): Promise<ImportConversionResult[]> {
        const results: ImportConversionResult[] = [];
        const text = document.getText();
        const lines = text.split("\n");

        for (const { statement, line } of scanConvertibleImports(lines)) {
            if (this.isFullPathImport(statement) && !this.isBuiltinModule(statement)) {
                const result = await this.convertFromFullPath(statement, line);
                if (result) {
                    results.push(result);
                }
            }
        }

        return results;
    }

    /**
     * Converts a relative import to a full path import
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

            const fullPathImport = usesCurlyBraces ? `using { ${fullPath} }` : `using. ${fullPath}`;

            return {
                originalImport: importStatement,
                fullPathImport,
                moduleName,
                isAmbiguous: false,
                line,
            };
        } else {
            const possiblePaths = possibleLocations.map((location) => ImportPathConverter.buildFullVersePath(projectVersePath, location, modulePath));

            return {
                originalImport: importStatement,
                fullPathImport: "", // Will be determined by user selection
                moduleName,
                isAmbiguous: true,
                possiblePaths,
                line,
            };
        }
    }

    /**
     * Converts all relative imports in a document to full path imports
     */
    async convertAllImportsInDocument(document: vscode.TextDocument): Promise<ImportConversionResult[]> {
        const results: ImportConversionResult[] = [];
        const text = document.getText();
        const lines = text.split("\n");

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
     * shared scanner rather than every line, so a fallback cannot land somewhere
     * a lens would never have appeared: searching the raw lines is what let the
     * commented-out copy absorb the edit in the first place.
     *
     * Comparison is by trimmed text, which also absorbs the trailing `\r` a CRLF
     * document leaves on every element of a `"\n"` split.
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
     * Applies a conversion result to the document
     */
    async applyConversion(document: vscode.TextDocument, conversion: ImportConversionResult, selectedPath?: string): Promise<boolean> {
        const text = document.getText();
        const lines = text.split("\n");
        const lineIndex = ImportPathConverter.findConversionLine(lines, conversion);

        if (lineIndex === -1) {
            logger.debug("ImportPathConverter", `Could not find import line: ${conversion.originalImport}`);
            return false;
        }

        let finalImport = conversion.fullPathImport;
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

import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportHandler, ImportPathConverter, ImportCodeLensProvider } from "../imports";
import { StatusBarHandler } from "../ui";
import { ProjectPathCache } from "../services";

/** The collaborators the commands act on, wired once during activation. */
export interface CommandsDependencies {
    importHandler: ImportHandler;
    statusBarHandler: StatusBarHandler;
    importPathConverter: ImportPathConverter;
    importCodeLensProvider: ImportCodeLensProvider;
    /**
     * Absent when the cache setting is off, so the dependency is missing in
     * fact and not only in type. The commands that would build one refuse
     * instead; only the status command carries on and reports the cache as
     * disabled. See activation for why one constructed here would be stale
     * from the moment it was written.
     */
    projectPathCache?: ProjectPathCache;
}

/**
 * A hand-maintained copy of ImportPathConverter's conversion result, which that
 * module does not export.
 *
 * The converter's return values reach this type by a cast, so nothing checks
 * the copy against the original at the point it is made. What does check it is
 * passing one back to applyConversion, which is typed on the original: a field
 * this copy lacks fails there, a field only this copy has fails nowhere.
 */
interface PathConversionResult {
    originalImport: string;
    fullPathImport: string;
    moduleName: string;
    isAmbiguous: boolean;
    possiblePaths?: string[];
    line?: number;
}

/** A command id paired with the method that runs it. */
type CommandEntry = [string, (...args: any[]) => any];

/**
 * The body of every command the extension contributes, and the one place they
 * are registered.
 */
export class CommandsHandler {
    private static readonly STATUS_MESSAGE_DURATION_MS = 3000;
    private static readonly SNOOZE_DURATION_MINUTES = 5;

    constructor(private readonly deps: CommandsDependencies) {}

    /**
     * Registers every command against the extension context, which disposes
     * them on deactivation.
     *
     * Each id here must also be declared in package.json under
     * `contributes.commands`, and the five that take caller-supplied arguments
     * must stay hidden from the Command Palette there - invoking one from the
     * palette dereferences an undefined document. Both halves are pinned:
     * commandManifest.test.ts checks the manifest, CommandsHandler.test.ts
     * checks this method registers every id once, and the integration suite
     * checks they are registered once the extension has activated.
     */
    registerAll(context: vscode.ExtensionContext): void {
        const commands: CommandEntry[] = [
            ...this.importCommands(),
            ...this.menuCommands(),
            ...this.toggleCommands(),
            ...this.snoozeCommands(),
            ...this.debugCommands(),
            ...this.pathCacheCommands(),
            ...this.pathConversionCommands(),
        ];

        for (const [commandId, handler] of commands) {
            context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
        }
    }

    private importCommands(): CommandEntry[] {
        return [
            ["verseAutoImports.addSingleImport", this.addSingleImport.bind(this)],
            ["verseAutoImports.optimizeImports", this.optimizeImports.bind(this)],
        ];
    }

    async addSingleImport(document: vscode.TextDocument, importStatement: string): Promise<void> {
        // A false here means applyEdit was rejected - a stale document version
        // or a read-only file - and the document is unchanged. Reporting the
        // import as added would leave the only trace in the output channel.
        const applied = await this.deps.importHandler.addImportsToDocument(document, [importStatement]);

        if (!applied) {
            logger.warn("CommandsHandler", `Failed to add import: ${importStatement}`);
            vscode.window.showWarningMessage(`Could not add import: ${importStatement}. The document may have changed or be read-only.`);
            return;
        }

        vscode.window.setStatusBarMessage(`Added import: ${importStatement}`, CommandsHandler.STATUS_MESSAGE_DURATION_MS);
    }

    /**
     * Rebuilds the active document's import block and saves it. Anything the
     * compiler currently reports as a missing import is added along the way.
     */
    async optimizeImports(): Promise<void> {
        logger.info("CommandsHandler", "Optimizing imports command triggered");

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            logger.debug("CommandsHandler", "No active editor found");
            vscode.window.showWarningMessage("Please open a file to optimize imports");
            return;
        }

        if (editor.document.languageId !== "verse") {
            logger.debug("CommandsHandler", "Active file is not a Verse file");
            vscode.window.showWarningMessage("Optimize imports only works with Verse files");
            return;
        }

        try {
            const document = editor.document;

            // Read straight from the current diagnostics rather than waiting on
            // the auto-import debounce, so the command does not race it.
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            const missingImportPaths = this.deps.importHandler.extractImportsFromDiagnostics(diagnostics);
            logger.debug("CommandsHandler", `Found ${missingImportPaths.length} missing import(s) in current diagnostics`);

            // The missing paths are handed to the organizer rather than added
            // first, so the block is rewritten once and the document is never
            // left between the two states.
            const applied = await this.deps.importHandler.organizeImports(document, missingImportPaths);

            // Saving a document whose edit was rejected writes the unorganized
            // content back to disk and makes the failure look like a success.
            if (!applied) {
                logger.warn("CommandsHandler", "Import organization was not applied to the document");
                vscode.window.showWarningMessage("Could not optimize imports. The document may have changed or be read-only.");
                return;
            }

            await document.save();

            logger.info("CommandsHandler", "Successfully optimized imports");
            vscode.window.showInformationMessage("Imports optimized successfully");
        } catch (error) {
            logger.error("CommandsHandler", "Error optimizing imports", error);
            vscode.window.showErrorMessage(`Failed to optimize imports: ${error}`);
        }
    }

    private menuCommands(): CommandEntry[] {
        return [["verseAutoImports.showStatusMenu", this.showStatusMenu.bind(this)]];
    }

    async showStatusMenu(): Promise<void> {
        await this.deps.statusBarHandler.showMenu();
    }

    private toggleCommands(): CommandEntry[] {
        return [
            ["verseAutoImports.toggleAutoImport", this.toggleAutoImport.bind(this)],
            ["verseAutoImports.togglePreserveLocations", this.togglePreserveLocations.bind(this)],
            ["verseAutoImports.toggleImportSyntax", this.toggleImportSyntax.bind(this)],
            ["verseAutoImports.toggleDigestFiles", this.toggleDigestFiles.bind(this)],
            ["verseAutoImports.toggleFullPathCodeLens", this.toggleFullPathCodeLens.bind(this)],
        ];
    }

    /**
     * Writes the opposite of a setting's current value to global scope, then
     * refreshes the status bar.
     *
     * @param toggleFn How to invert a value that is not a boolean. Omit it and
     *   the current value is negated.
     */
    private async toggleConfig<T>(configKey: string, toggleFn?: (current: T) => T): Promise<void> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const current = config.get<T>(configKey);
        const newValue = toggleFn ? toggleFn(current as T) : !current;
        await config.update(configKey, newValue, vscode.ConfigurationTarget.Global);
        this.deps.statusBarHandler.updateDisplay();
    }

    async toggleAutoImport(): Promise<void> {
        await this.toggleConfig<boolean>("general.autoImport");
    }

    async togglePreserveLocations(): Promise<void> {
        await this.toggleConfig<boolean>("behavior.preserveImportLocations");
    }

    async toggleImportSyntax(): Promise<void> {
        await this.toggleConfig<string>("behavior.importSyntax", (current) => (current === "curly" ? "dot" : "curly"));
    }

    async toggleDigestFiles(): Promise<void> {
        await this.toggleConfig<boolean>("experimental.useDigestFiles");
    }

    async toggleFullPathCodeLens(): Promise<void> {
        await this.toggleConfig<boolean>("pathConversion.enableCodeLens");
    }

    private snoozeCommands(): CommandEntry[] {
        return [
            ["verseAutoImports.snoozeAutoImport", this.snoozeAutoImport.bind(this)],
            ["verseAutoImports.cancelSnooze", this.cancelSnooze.bind(this)],
        ];
    }

    async snoozeAutoImport(): Promise<void> {
        this.deps.statusBarHandler.startSnooze(CommandsHandler.SNOOZE_DURATION_MINUTES);
    }

    async cancelSnooze(): Promise<void> {
        this.deps.statusBarHandler.cancelSnooze();
    }

    private debugCommands(): CommandEntry[] {
        return [
            ["verseAutoImports.exportDebugLogs", this.exportDebugLogs.bind(this)],
            ["verseAutoImports.captureDiagnosticsCorpus", this.captureDiagnosticsCorpus.bind(this)],
        ];
    }

    async exportDebugLogs(): Promise<void> {
        try {
            const uri = await logger.exportDebugLogs();
            if (uri) {
                const action = await vscode.window.showInformationMessage(`Debug logs exported to ${uri.fsPath}`, "Open File", "Open Folder");
                if (action === "Open File") {
                    await vscode.commands.executeCommand("vscode.open", uri);
                } else if (action === "Open Folder") {
                    await vscode.commands.executeCommand("revealFileInOS", uri);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export debug logs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Writes the current Verse compiler diagnostics of every open document to a
     * JSON file, which is how the message-format regression corpus in
     * test-fixtures/corpus is maintained. Its README has the curation workflow.
     */
    async captureDiagnosticsCorpus(): Promise<void> {
        try {
            interface CapturedDocument {
                file: string;
                diagnostics: Array<{ severity: number; startLine: number; message: string }>;
            }

            const documents: CapturedDocument[] = [];
            for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
                if (!uri.path.endsWith(".verse") || diagnostics.length === 0) {
                    continue;
                }
                documents.push({
                    file: uri.toString(),
                    diagnostics: diagnostics.map((diagnostic) => ({
                        severity: diagnostic.severity,
                        startLine: diagnostic.range.start.line,
                        message: diagnostic.message,
                    })),
                });
            }

            if (documents.length === 0) {
                vscode.window.showInformationMessage("No Verse diagnostics to capture");
                return;
            }

            const target = await vscode.window.showSaveDialog({
                filters: { JSON: ["json"] },
                saveLabel: "Save diagnostics capture",
            });
            if (!target) {
                return;
            }

            const payload = { capturedAt: new Date().toISOString(), documents };
            await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(payload, null, 4) + "\n", "utf8"));

            const action = await vscode.window.showInformationMessage(`Captured diagnostics from ${documents.length} file(s) to ${target.fsPath}`, "Open File");
            if (action === "Open File") {
                await vscode.commands.executeCommand("vscode.open", target);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to capture diagnostics: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private pathCacheCommands(): CommandEntry[] {
        return [
            ["verseAutoImports.rebuildPathCache", this.rebuildPathCache.bind(this)],
            ["verseAutoImports.clearPathCache", this.clearPathCache.bind(this)],
            ["verseAutoImports.showCacheStatus", this.showCacheStatus.bind(this)],
        ];
    }

    async rebuildPathCache(): Promise<void> {
        if (!this.deps.projectPathCache) {
            vscode.window.showWarningMessage("Project path cache is not enabled");
            return;
        }

        logger.info("CommandsHandler", "Rebuilding project path cache");

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Rebuilding project path cache...",
                cancellable: false,
            },
            async () => {
                await this.deps.projectPathCache!.rebuildCache();
            },
        );

        const stats = this.deps.projectPathCache.getStats();
        vscode.window.showInformationMessage(`Project path cache rebuilt: ${stats.identifiers} identifiers from ${stats.files} files`);
    }

    /**
     * Clears the project path cache without rebuilding it, wiping both the
     * in-memory state and the persisted workspace-storage copy.
     */
    async clearPathCache(): Promise<void> {
        if (!this.deps.projectPathCache) {
            vscode.window.showWarningMessage("Project path cache is not enabled");
            return;
        }

        try {
            logger.info("CommandsHandler", "Clearing project path cache");

            await this.deps.projectPathCache.clearAll();

            vscode.window.showInformationMessage("Project path cache cleared");
        } catch (error) {
            logger.error("CommandsHandler", "Failed to clear project path cache", error);
            vscode.window.showErrorMessage(`Failed to clear project path cache: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async showCacheStatus(): Promise<void> {
        try {
            const cacheStats = this.deps.projectPathCache?.getStats();

            const lines: string[] = [];

            if (cacheStats) {
                lines.push(`Project Cache: ${cacheStats.loaded ? "Loaded" : "Not loaded"}`);
                if (cacheStats.loaded) {
                    lines.push(`  Identifiers: ${cacheStats.identifiers}`);
                    lines.push(`  Files: ${cacheStats.files}`);
                    if (cacheStats.generatedAt) {
                        const age = Date.now() - cacheStats.generatedAt;
                        const ageMinutes = Math.floor(age / 60000);
                        lines.push(`  Age: ${ageMinutes} minutes`);
                    }
                }
            } else {
                lines.push("Project Cache: Disabled");
            }

            lines.push("");
            lines.push("Cache Location: VS Code Workspace Storage");

            vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
        } catch (error) {
            logger.error("CommandsHandler", "Error showing cache status", error);
            vscode.window.showErrorMessage(`Failed to show cache status: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private pathConversionCommands(): CommandEntry[] {
        return [
            ["verseAutoImports.convertToFullPath", this.convertToFullPath.bind(this)],
            ["verseAutoImports.convertAllToFullPath", this.convertAllToFullPath.bind(this)],
            ["verseAutoImports.convertToRelativePath", this.convertToRelativePath.bind(this)],
            ["verseAutoImports.convertAllToRelativePath", this.convertAllToRelativePath.bind(this)],
        ];
    }

    /**
     * Holds the CodeLens open across a conversion, by cancelling the pending
     * hide timer and pinning the hover flag. Without it a conversion that takes
     * longer than the hide delay - an ambiguous one waits on a quick pick -
     * finishes against a lens that has already gone.
     */
    private prepareForConversion(documentUri: string): void {
        this.deps.importCodeLensProvider.keepHoverStateActive(documentUri);
    }

    private finalizeConversion(documentUri: string): void {
        this.deps.importCodeLensProvider.forceRefreshAfterConversion(documentUri);
    }

    /**
     * Reports a conversion the document refused. applyConversion returns false
     * when it cannot find the line to rewrite, when applyEdit is rejected, or
     * when the edit throws, and the document is unchanged in all three cases -
     * reporting the new path would leave the only trace in the output channel.
     */
    private reportRefusedConversion(originalImport: string): void {
        logger.warn("CommandsHandler", `Failed to convert import: ${originalImport}`);
        vscode.window.showWarningMessage(`Could not convert import: ${originalImport}. The document may have changed or be read-only.`);
    }

    /**
     * Reports the outcome of a whole-document conversion. A count alone does
     * not read as a failure: a run where every edit was refused still reports
     * a number, so any failure has to say so in its own words.
     */
    private reportConversionTotals(pathKind: "absolute" | "relative", convertedCount: number, failedCount: number): void {
        const summary = `Using ${pathKind} paths for ${convertedCount} import${convertedCount !== 1 ? "s" : ""}.`;

        if (failedCount === 0) {
            vscode.window.showInformationMessage(summary);
            return;
        }

        logger.warn("CommandsHandler", `${failedCount} conversion(s) were not applied to the document`);
        vscode.window.showWarningMessage(`${summary} ${failedCount} could not be converted. The document may have changed or be read-only.`);
    }

    /**
     * Asks which of several candidate paths to use, and returns undefined when
     * the user dismisses the pick. A dismissal is a decline rather than a
     * failure, and callers count it as neither converted nor failed.
     */
    private async selectAmbiguousPath(result: PathConversionResult): Promise<string | undefined> {
        if (!result.possiblePaths) return undefined;

        const items = result.possiblePaths.map((path) => ({
            label: path,
            description: `Absolute path for ${result.moduleName}`,
            path,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select the absolute path for '${result.moduleName}'`,
            title: "Multiple locations found",
        });

        return selected?.path;
    }

    async convertToFullPath(document: vscode.TextDocument, importStatement: string, lineNumber: number): Promise<void> {
        const documentUri = document.uri.toString();
        this.prepareForConversion(documentUri);

        // The line the lens was clicked on travels with the conversion, so the
        // edit lands there rather than on the first line reading the same.
        const result = (await this.deps.importPathConverter.convertToFullPath(importStatement, document.uri, lineNumber)) as PathConversionResult | null;

        if (!result) {
            vscode.window.showInformationMessage("Import is already in absolute path format or could not be converted.");
            return;
        }

        if (result.isAmbiguous && result.possiblePaths) {
            const selectedPath = await this.selectAmbiguousPath(result);
            if (selectedPath) {
                const applied = await this.deps.importPathConverter.applyConversion(document, result, selectedPath);
                if (!applied) {
                    this.reportRefusedConversion(result.originalImport);
                    return;
                }

                vscode.window.setStatusBarMessage(`Using absolute path: ${selectedPath}`, CommandsHandler.STATUS_MESSAGE_DURATION_MS);
                this.finalizeConversion(documentUri);
            }
        } else {
            const applied = await this.deps.importPathConverter.applyConversion(document, result);
            if (!applied) {
                this.reportRefusedConversion(result.originalImport);
                return;
            }

            vscode.window.setStatusBarMessage(`Using absolute path: ${result.fullPathImport}`, CommandsHandler.STATUS_MESSAGE_DURATION_MS);
            this.finalizeConversion(documentUri);
        }
    }

    async convertAllToFullPath(document: vscode.TextDocument): Promise<void> {
        const documentUri = document.uri.toString();
        this.prepareForConversion(documentUri);

        const results = (await this.deps.importPathConverter.convertAllImportsInDocument(document)) as PathConversionResult[];

        if (results.length === 0) {
            vscode.window.showInformationMessage("No relative imports found to convert.");
            return;
        }

        let convertedCount = 0;
        let failedCount = 0;
        const ambiguousImports: PathConversionResult[] = [];

        // Every unambiguous conversion is applied before the first question is
        // asked, so a user who dismisses the picks still gets the rest.
        for (const result of results) {
            if (!result.isAmbiguous) {
                const success = await this.deps.importPathConverter.applyConversion(document, result);
                if (success) convertedCount++;
                else failedCount++;
            } else {
                ambiguousImports.push(result);
            }
        }

        for (const result of ambiguousImports) {
            const selectedPath = await this.selectAmbiguousPath(result);
            if (selectedPath) {
                const success = await this.deps.importPathConverter.applyConversion(document, result, selectedPath);
                if (success) convertedCount++;
                else failedCount++;
            }
        }

        this.reportConversionTotals("absolute", convertedCount, failedCount);
        this.finalizeConversion(documentUri);
    }

    async convertToRelativePath(document: vscode.TextDocument, importStatement: string, lineNumber: number): Promise<void> {
        const documentUri = document.uri.toString();
        this.prepareForConversion(documentUri);

        const result = (await this.deps.importPathConverter.convertFromFullPath(importStatement, lineNumber)) as PathConversionResult | null;

        if (!result) {
            vscode.window.showInformationMessage("Import cannot be converted to relative path.");
            return;
        }

        const applied = await this.deps.importPathConverter.applyConversion(document, result);
        if (!applied) {
            this.reportRefusedConversion(result.originalImport);
            return;
        }

        vscode.window.setStatusBarMessage(`Using relative path: ${result.fullPathImport}`, CommandsHandler.STATUS_MESSAGE_DURATION_MS);
        this.finalizeConversion(documentUri);
    }

    async convertAllToRelativePath(document: vscode.TextDocument): Promise<void> {
        const documentUri = document.uri.toString();
        this.prepareForConversion(documentUri);

        const results = (await this.deps.importPathConverter.convertAllImportsFromFullPath(document)) as PathConversionResult[];

        if (results.length === 0) {
            vscode.window.showInformationMessage("No absolute path imports found to convert.");
            return;
        }

        let convertedCount = 0;
        let failedCount = 0;
        for (const result of results) {
            const success = await this.deps.importPathConverter.applyConversion(document, result);
            if (success) convertedCount++;
            else failedCount++;
        }

        this.reportConversionTotals("relative", convertedCount, failedCount);
        this.finalizeConversion(documentUri);
    }
}

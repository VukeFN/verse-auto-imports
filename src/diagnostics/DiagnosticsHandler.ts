import * as vscode from "vscode";
import * as path from "path";
import { logger } from "../utils";
import { ImportSuggestion } from "../types";
import { ImportHandler } from "../imports";

export class DiagnosticsHandler {
    private importHandler: ImportHandler;
    private processingDocuments: Set<string> = new Set();
    private pendingTimers: Map<string, NodeJS.Timeout> = new Map();
    private delayMs: number = 1000;
    private disposed = false;

    constructor(
        private outputChannel: vscode.OutputChannel,
        importHandler: ImportHandler,
        // Consulted when a debounce timer fires, not when it is scheduled, so
        // a snooze started while a timer is already pending still suppresses
        // that import. Returns false when nothing is suppressing auto-import.
        // Required rather than defaulted: a call site that forgot it would
        // lose suppression silently at runtime instead of failing the build.
        private isAutoImportSuppressed: () => boolean,
    ) {
        // Use the shared, fully-wired ImportHandler so the auto-import path has
        // the same asset-class detection and precompiled digests as quick fixes.
        this.importHandler = importHandler;
        logger.debug("DiagnosticsHandler", `Initialized with ${this.delayMs}ms delay`);
    }

    /**
     * Decides whether a diagnostics URI should be processed at all, before any
     * document is opened. Diagnostics events also carry VS Code internal
     * documents (e.g. private: replace-preview buffers, git: views) that throw
     * on openTextDocument, and Epic's generated *.digest.verse files, which
     * hold permanent LSP errors and must never be edited by the extension.
     */
    static shouldProcessUri(uri: { scheme: string; fsPath: string }): boolean {
        if (uri.scheme !== "file") {
            return false;
        }
        const fsPath = uri.fsPath.toLowerCase();
        return fsPath.endsWith(".verse") && !fsPath.endsWith(".digest.verse");
    }

    /**
     * Decides whether a diagnostics URI is inside the configured auto-import
     * scope. The Verse LSP publishes diagnostics for the whole project, not
     * only for what is on screen, so without this the extension edits any
     * .verse file the compiler complains about.
     *
     * Callers must consult this before opening the document: opening one is
     * itself the behaviour "openFiles" exists to prevent, since it pulls a file
     * the user never opened into the workspace.
     *
     * URIs are compared by their string form, as the rest of the extension
     * keys per-document state, never by fsPath - two URIs can share a path and
     * differ in scheme or query.
     *
     * visibility.openUris must be built from the open tabs, not from
     * vscode.workspace.textDocuments. That list holds every document opened
     * programmatically by anything, and this extension's own ProjectPathScanner
     * opens every .verse file in the project to build the path cache - so keyed
     * on it, "openFiles" would admit the whole project and mean nothing.
     *
     * An unrecognized scope falls back to "allFiles", so a mistyped setting
     * degrades to the previous behaviour instead of silently disabling
     * auto-import altogether.
     */
    static isUriInScope(uri: { toString(): string }, scope: string, visibility: { openUris: readonly string[]; activeUri?: string }): boolean {
        if (scope !== "openFiles" && scope !== "activeFile") {
            return true;
        }
        const target = uri.toString();
        if (scope === "activeFile") {
            return visibility.activeUri === target;
        }
        return visibility.openUris.includes(target);
    }

    async handle(document: vscode.TextDocument) {
        // The diagnostics listener awaits openTextDocument before calling in,
        // so a continuation can resume after teardown. Arming a timer here
        // would put back exactly what dispose() just cancelled.
        if (this.disposed) {
            return;
        }

        // Key the debounce state by the full URI, never by the basename: UEFN
        // projects routinely hold same-named files in different module folders
        // (Weapons/utils.verse and UI/utils.verse), and a shared key makes one
        // file's diagnostics cancel or block the other's timer, silently
        // dropping an auto-import. The basename stays as the log label only.
        const documentKey = document.uri.toString();
        const displayName = path.basename(document.uri.fsPath);

        logger.trace("DiagnosticsHandler", `Received diagnostics for ${displayName}`);

        // Cancel any pending timer for this document
        const existingTimer = this.pendingTimers.get(documentKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.pendingTimers.delete(documentKey);
            logger.trace("DiagnosticsHandler", `Cancelled pending timer for ${displayName} (debouncing)`);
        }

        // If already processing this document, don't start a new timer
        if (this.processingDocuments.has(documentKey)) {
            logger.debug("DiagnosticsHandler", `Already processing ${displayName}, skipping new timer`);
            return;
        }

        logger.debug("DiagnosticsHandler", `Starting debounce timer (${this.delayMs}ms) for ${displayName}`);

        // Create new timer with proper debouncing
        const timer = setTimeout(async () => {
            // Remove from pending timers
            this.pendingTimers.delete(documentKey);

            // Mark as processing
            this.processingDocuments.add(documentKey);
            try {
                const currentDiagnostics = vscode.languages.getDiagnostics(document.uri);

                logger.debug("DiagnosticsHandler", `Processing diagnostics for ${displayName} after delay`);

                const config = vscode.workspace.getConfiguration("verseAutoImports");
                const autoImportEnabled = config.get<boolean>("general.autoImport", true) && !this.isAutoImportSuppressed();
                const multiOptionStrategy = config.get<string>("behavior.multiOptionStrategy", "quickfix");

                const autoImportSuggestions = new Set<string>();
                let hasMultiOptionSuggestions = false;

                for (const diagnostic of currentDiagnostics) {
                    const suggestions = await this.importHandler.extractImportSuggestions(diagnostic.message);

                    if (suggestions.length === 0) {
                        // No suggestions found, skip this diagnostic
                        continue;
                    }

                    if (suggestions.length > 1) {
                        // Multi-option scenario detected
                        hasMultiOptionSuggestions = true;
                        logger.debug("DiagnosticsHandler", `Multi-option diagnostic found with ${suggestions.length} suggestions - will use quick fixes`);

                        if (multiOptionStrategy.startsWith("auto_")) {
                            // Auto-select one option for import
                            const selectedSuggestion = this.selectBestSuggestion(suggestions, multiOptionStrategy);
                            if (selectedSuggestion && autoImportEnabled) {
                                autoImportSuggestions.add(selectedSuggestion.importStatement);
                                logger.debug("DiagnosticsHandler", `Auto-selected: ${selectedSuggestion.importStatement}`);
                            }
                        }
                        // For quickfix strategy, let ImportCodeActionProvider handle it
                        continue;
                    }

                    // Single suggestion - can auto-import if enabled
                    const suggestion = suggestions[0];
                    if (autoImportEnabled && suggestion.confidence === "high") {
                        logger.debug("DiagnosticsHandler", `Adding high-confidence import: ${suggestion.importStatement}`);
                        autoImportSuggestions.add(suggestion.importStatement);
                    } else {
                        logger.debug("DiagnosticsHandler", `Low confidence or auto-import disabled - will use quick fix for: ${suggestion.importStatement}`);
                    }
                }

                // Teardown can land between the timer firing and here, because
                // extracting suggestions is awaited. clearTimeout in dispose()
                // cannot cancel a callback that has already started, so the
                // edit is the point that has to re-check.
                if (this.disposed) {
                    logger.debug("DiagnosticsHandler", `Discarding diagnostics for ${displayName}: handler disposed`);
                    return;
                }

                // Apply auto-imports if any were collected
                if (autoImportSuggestions.size > 0) {
                    logger.info("DiagnosticsHandler", `Auto-importing ${autoImportSuggestions.size} statements`);
                    autoImportSuggestions.forEach((imp) => {
                        logger.debug("DiagnosticsHandler", `Will auto-import: ${imp}`);
                    });

                    // The edit is rejected when the document moved on between
                    // the read and the write, or when the file is read-only.
                    // Reporting the imports as applied hides that entirely.
                    const applied = await this.importHandler.addImportsToDocument(document, Array.from(autoImportSuggestions));

                    if (applied) {
                        vscode.window.setStatusBarMessage(`Auto-imported ${autoImportSuggestions.size} statements to ${displayName}`, 3000);
                    } else {
                        logger.warn("DiagnosticsHandler", `Failed to auto-import ${autoImportSuggestions.size} statements to ${displayName}`);
                        vscode.window.showWarningMessage(`Could not auto-import ${autoImportSuggestions.size} statement(s) into ${displayName}. The document may have changed or be read-only.`);
                    }
                }

                // Show status for multi-option diagnostics
                if (hasMultiOptionSuggestions && multiOptionStrategy === "quickfix") {
                    vscode.window.setStatusBarMessage(`Multiple import options available - use quick fixes (Ctrl+.)`, 5000);
                }
            } catch (error) {
                logger.error("DiagnosticsHandler", "Error processing diagnostics", error);
            } finally {
                this.processingDocuments.delete(documentKey);
                logger.trace("DiagnosticsHandler", `Finished processing ${displayName}`);
            }
        }, this.delayMs);

        // Store the timer so it can be cancelled if needed
        this.pendingTimers.set(documentKey, timer);
    }

    private selectBestSuggestion(suggestions: ImportSuggestion[], strategy: string): ImportSuggestion | null {
        if (suggestions.length === 0) {
            return null;
        }

        switch (strategy) {
            case "auto_shortest":
                // Return the suggestion with the shortest import statement
                return suggestions.reduce((shortest, current) => (current.importStatement.length < shortest.importStatement.length ? current : shortest));
            case "auto_first":
                return suggestions[0];
            default:
                return suggestions[0]; // fallback
        }
    }

    setDelay(delayMs: number) {
        this.delayMs = delayMs;
        logger.info("DiagnosticsHandler", `Diagnostic processing delay set to ${delayMs}ms`);
    }

    /**
     * Cancels every armed debounce timer so none can fire after deactivation.
     * The delay is user-configurable, so a timer armed by the last keystroke
     * before a reload would otherwise apply an edit to a document belonging to
     * a torn-down extension.
     */
    dispose(): void {
        this.disposed = true;
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
        logger.debug("DiagnosticsHandler", "Disposed: pending debounce timers cancelled");
    }
}

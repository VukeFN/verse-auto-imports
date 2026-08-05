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

    async handle(document: vscode.TextDocument) {
        const documentKey = path.basename(document.uri.fsPath);

        logger.trace("DiagnosticsHandler", `Received diagnostics for ${documentKey}`);

        // Cancel any pending timer for this document
        const existingTimer = this.pendingTimers.get(documentKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.pendingTimers.delete(documentKey);
            logger.trace("DiagnosticsHandler", `Cancelled pending timer for ${documentKey} (debouncing)`);
        }

        // If already processing this document, don't start a new timer
        if (this.processingDocuments.has(documentKey)) {
            logger.debug("DiagnosticsHandler", `Already processing ${documentKey}, skipping new timer`);
            return;
        }

        logger.debug("DiagnosticsHandler", `Starting debounce timer (${this.delayMs}ms) for ${documentKey}`);

        // Create new timer with proper debouncing
        const timer = setTimeout(async () => {
            // Remove from pending timers
            this.pendingTimers.delete(documentKey);

            // Mark as processing
            this.processingDocuments.add(documentKey);
            try {
                const currentDiagnostics = vscode.languages.getDiagnostics(document.uri);

                logger.debug("DiagnosticsHandler", `Processing diagnostics for ${documentKey} after delay`);

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

                // Apply auto-imports if any were collected
                if (autoImportSuggestions.size > 0) {
                    logger.info("DiagnosticsHandler", `Auto-importing ${autoImportSuggestions.size} statements`);
                    autoImportSuggestions.forEach((imp) => {
                        logger.debug("DiagnosticsHandler", `Will auto-import: ${imp}`);
                    });

                    await this.importHandler.addImportsToDocument(document, Array.from(autoImportSuggestions));
                    vscode.window.setStatusBarMessage(`Auto-imported ${autoImportSuggestions.size} statements to ${path.basename(document.uri.fsPath)}`, 3000);
                }

                // Show status for multi-option diagnostics
                if (hasMultiOptionSuggestions && multiOptionStrategy === "quickfix") {
                    vscode.window.setStatusBarMessage(`Multiple import options available - use quick fixes (Ctrl+.)`, 5000);
                }
            } catch (error) {
                logger.error("DiagnosticsHandler", "Error processing diagnostics", error);
            } finally {
                this.processingDocuments.delete(documentKey);
                logger.trace("DiagnosticsHandler", `Finished processing ${documentKey}`);
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
}

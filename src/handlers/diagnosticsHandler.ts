import * as vscode from "vscode";
import * as path from "path";
import { ImportHandler } from "./importHandler";
// import { ModuleHandler } from "./moduleHandler";
import { log } from "../utils/logging";
import { ImportSuggestion } from "../types/moduleInfo";

export class DiagnosticsHandler {
    private importHandler: ImportHandler;
    // private moduleHandler: ModuleHandler;
    private processingDocuments: Set<string> = new Set();
    private delayMs: number = 1000;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.importHandler = new ImportHandler(outputChannel);
        // this.moduleHandler = new ModuleHandler(outputChannel);
        log(
            this.outputChannel,
            `DiagnosticsHandler initialized with ${this.delayMs}ms delay`
        );
    }

    async handle(document: vscode.TextDocument) {
        const documentKey = path.basename(document.uri.fsPath);

        log(this.outputChannel, `Received diagnostics for ${documentKey}`);

        if (this.processingDocuments.has(documentKey)) {
            log(
                this.outputChannel,
                `⚠️ Already processing ${documentKey}, skipping`
            );
            return;
        }

        this.processingDocuments.add(documentKey);

        log(
            this.outputChannel,
            `⏱️ Waiting ${this.delayMs}ms before processing diagnostics for ${documentKey}`
        );

        setTimeout(async () => {
            try {
                const currentDiagnostics = vscode.languages.getDiagnostics(
                    document.uri
                );

                log(
                    this.outputChannel,
                    `Processing diagnostics for ${documentKey} after delay`
                );

                const config = vscode.workspace.getConfiguration("verseAutoImports");
                const autoImportEnabled = config.get<boolean>("autoImport", true);
                const multiOptionStrategy = config.get<string>("multiOptionStrategy", "quickfix");

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
                        log(
                            this.outputChannel,
                            `Multi-option diagnostic found with ${suggestions.length} suggestions - will use quick fixes`
                        );

                        if (multiOptionStrategy.startsWith("auto_")) {
                            // Auto-select one option for import
                            const selectedSuggestion = this.selectBestSuggestion(suggestions, multiOptionStrategy);
                            if (selectedSuggestion && autoImportEnabled) {
                                autoImportSuggestions.add(selectedSuggestion.importStatement);
                                log(this.outputChannel, `Auto-selected: ${selectedSuggestion.importStatement}`);
                            }
                        }
                        // For quickfix strategy, let ImportCodeActionProvider handle it
                        continue;
                    }

                    // Single suggestion - can auto-import if enabled
                    const suggestion = suggestions[0];
                    if (autoImportEnabled && suggestion.confidence === 'high') {
                        log(
                            this.outputChannel,
                            `Adding high-confidence import: ${suggestion.importStatement}`
                        );
                        autoImportSuggestions.add(suggestion.importStatement);
                    } else {
                        log(
                            this.outputChannel,
                            `Low confidence or auto-import disabled - will use quick fix for: ${suggestion.importStatement}`
                        );
                    }

                    // Note: ModuleHandler logic would go here
                    // await this.moduleHandler.handleModuleError(diagnostic, document);
                }

                // Apply auto-imports if any were collected
                if (autoImportSuggestions.size > 0) {
                    log(
                        this.outputChannel,
                        `Auto-importing ${autoImportSuggestions.size} statements`
                    );
                    autoImportSuggestions.forEach((imp) => {
                        log(this.outputChannel, `Will auto-import: ${imp}`);
                    });

                    await this.importHandler.addImportsToDocument(
                        document,
                        Array.from(autoImportSuggestions)
                    );
                    vscode.window.setStatusBarMessage(
                        `Auto-imported ${autoImportSuggestions.size} statements to ${path.basename(document.uri.fsPath)}`,
                        3000
                    );
                }

                // Show status for multi-option diagnostics
                if (hasMultiOptionSuggestions && multiOptionStrategy === "quickfix") {
                    vscode.window.setStatusBarMessage(
                        `Multiple import options available - use quick fixes (Ctrl+.)`,
                        5000
                    );
                }
            } catch (error) {
                log(
                    this.outputChannel,
                    `❌ Error processing diagnostics: ${error}`
                );
            } finally {
                this.processingDocuments.delete(documentKey);
                log(
                    this.outputChannel,
                    `🔄 Finished processing ${documentKey}`
                );
            }
        }, this.delayMs);
    }

    private selectBestSuggestion(suggestions: ImportSuggestion[], strategy: string): ImportSuggestion | null {
        if (suggestions.length === 0) {
            return null;
        }

        switch (strategy) {
            case "auto_shortest":
                // Return the suggestion with the shortest import statement
                return suggestions.reduce((shortest, current) =>
                    current.importStatement.length < shortest.importStatement.length ? current : shortest
                );
            case "auto_first":
                return suggestions[0];
            default:
                return suggestions[0]; // fallback
        }
    }

    setDelay(delayMs: number) {
        this.delayMs = delayMs;
        log(
            this.outputChannel,
            `⚙️ Diagnostic processing delay set to ${delayMs}ms`
        );
    }
}

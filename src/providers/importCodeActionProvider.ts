import * as vscode from "vscode";
import { ImportHandler } from "../handlers/importHandler";
import { log } from "../utils/logging";
import { ImportSuggestion } from "../types/moduleInfo";

export class ImportCodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private importHandler: ImportHandler
    ) {}

    async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[] | undefined> {
        const codeActions: vscode.CodeAction[] = [];
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const quickFixOrdering = config.get<string>("quickFixOrdering", "confidence");
        const showDescriptions = config.get<boolean>("showQuickFixDescriptions", true);

        for (const diagnostic of context.diagnostics) {
            const suggestions = await this.importHandler.extractImportSuggestions(diagnostic.message);

            if (suggestions.length === 0) {
                continue;
            }

            // Sort suggestions based on user preference
            const sortedSuggestions = this.sortSuggestions(suggestions, quickFixOrdering);

            log(
                this.outputChannel,
                `Creating ${sortedSuggestions.length} quick fix action(s) for diagnostic`
            );

            // Create quick fix actions for each suggestion
            sortedSuggestions.forEach((suggestion, index) => {
                const action = this.createQuickFixAction(
                    suggestion,
                    diagnostic,
                    document,
                    index === 0, // Mark first as preferred
                    showDescriptions
                );
                codeActions.push(action);
            });
        }

        return codeActions.length > 0 ? codeActions : undefined;
    }

    private sortSuggestions(suggestions: ImportSuggestion[], ordering: string): ImportSuggestion[] {
        const sorted = [...suggestions]; // Create a copy

        switch (ordering) {
            case "confidence":
                // Sort by confidence (high, medium, low) then by length
                const confidenceOrder = { 'high': 0, 'medium': 1, 'low': 2 };
                sorted.sort((a, b) => {
                    const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
                    if (confDiff !== 0) return confDiff;
                    return a.importStatement.length - b.importStatement.length;
                });
                break;
            case "alphabetical":
                sorted.sort((a, b) => a.importStatement.localeCompare(b.importStatement));
                break;
            case "module_priority":
                // Could implement module priority here based on configuration
                // For now, fall back to confidence ordering
                return this.sortSuggestions(suggestions, "confidence");
            default:
                return sorted; // No sorting
        }

        return sorted;
    }

    private createQuickFixAction(
        suggestion: ImportSuggestion,
        diagnostic: vscode.Diagnostic,
        document: vscode.TextDocument,
        isPreferred: boolean,
        showDescriptions: boolean
    ): vscode.CodeAction {
        // Create descriptive title
        let title = `✓ Add import: ${suggestion.importStatement}`;
        if (showDescriptions && suggestion.description) {
            title += ` (${suggestion.description})`;
        }

        // Add confidence indicator for multiple options
        if (showDescriptions && suggestion.confidence !== 'high') {
            const indicator = suggestion.confidence === 'medium' ? '⚠' : '❓';
            title = `${indicator} ${title}`;
        }

        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

        action.isPreferred = isPreferred;
        action.kind = vscode.CodeActionKind.QuickFix.append("verse.import");
        action.diagnostics = [diagnostic];

        action.command = {
            title: "Add Import",
            command: "verseAutoImports.addSingleImport",
            arguments: [document, suggestion.importStatement],
        };

        return action;
    }
}

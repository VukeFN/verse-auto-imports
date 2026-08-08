import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportSuggestion } from "../types";
import { ImportHandler } from "./ImportHandler";

export class ImportCodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private importHandler: ImportHandler,
    ) {}

    async provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[] | undefined> {
        const codeActions: vscode.CodeAction[] = [];
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const sortAlphabetically = config.get<boolean>("quickFix.sortAlphabetically", false);
        // false is what package.json registers, and config.get returns the
        // registered default for a registered setting - so a fallback of true
        // never reached production and only ever changed what the tests saw.
        const showDescriptions = config.get<boolean>("quickFix.showDescriptions", false);

        for (const diagnostic of context.diagnostics) {
            const suggestions = await this.importHandler.extractImportSuggestions(diagnostic.message);

            if (suggestions.length === 0) {
                continue;
            }

            // Sort suggestions based on user preference
            const sortedSuggestions = this.sortSuggestions(suggestions, sortAlphabetically);

            logger.debug("ImportCodeActionProvider", `Creating ${sortedSuggestions.length} quick fix action(s) for diagnostic`);

            // Create quick fix actions for each suggestion
            sortedSuggestions.forEach((suggestion, index) => {
                const action = this.createQuickFixAction(
                    suggestion,
                    diagnostic,
                    document,
                    index === 0, // Mark first as preferred
                    showDescriptions,
                );
                codeActions.push(action);
            });
        }

        return codeActions.length > 0 ? codeActions : undefined;
    }

    private sortSuggestions(suggestions: ImportSuggestion[], sortAlphabetically: boolean): ImportSuggestion[] {
        const sorted = [...suggestions]; // Create a copy

        if (sortAlphabetically) {
            // Sort alphabetically by import statement
            sorted.sort((a, b) => a.importStatement.localeCompare(b.importStatement));
        }
        // If not sorting alphabetically, preserve the original order

        return sorted;
    }

    private createQuickFixAction(suggestion: ImportSuggestion, diagnostic: vscode.Diagnostic, document: vscode.TextDocument, isPreferred: boolean, showDescriptions: boolean): vscode.CodeAction {
        // Create descriptive title
        let title = `Add import: ${suggestion.importStatement}`;
        if (showDescriptions && suggestion.description) {
            title += ` (${suggestion.description})`;
        }

        // Add confidence indicator for multiple options
        if (showDescriptions && suggestion.confidence !== "high") {
            const indicator = suggestion.confidence === "medium" ? "[medium confidence]" : "[low confidence]";
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

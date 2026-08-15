import * as vscode from "vscode";
import { logger, settingsFor } from "../utils";
import { ImportSuggestion } from "../types";
import { ImportHandler } from "./ImportHandler";

/**
 * Turns the imports a Verse diagnostic suggests into quick fixes.
 *
 * The suggestions come from the diagnostic's own message, so a compiler error
 * naming no import produces no action.
 */
export class ImportCodeActionProvider implements vscode.CodeActionProvider {
    /**
     * Declared to the registration so VS Code skips this provider whenever a
     * kind outside quick fixes is requested. Without it a refactor or source
     * action menu runs the async extraction below for a request this provider
     * can never serve.
     */
    static readonly providedCodeActionKinds: readonly vscode.CodeActionKind[] = [vscode.CodeActionKind.QuickFix];

    constructor(
        private outputChannel: vscode.OutputChannel,
        private importHandler: ImportHandler,
    ) {}

    /**
     * A quick fix for every import the diagnostics at this range suggest, or
     * undefined when they suggest none.
     *
     * The first action of each diagnostic is marked preferred, so which
     * suggestion the editor offers first depends on the sort.
     */
    async provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[] | undefined> {
        const codeActions: vscode.CodeAction[] = [];
        const config = settingsFor(document.uri);
        const sortAlphabetically = config.get<boolean>("quickFix.sortAlphabetically", false);
        // Only a caller with no registered setting behind it, such as a test,
        // ever sees this fallback - config.get returns the registered default
        // otherwise, and package.json registers false.
        const showDescriptions = config.get<boolean>("quickFix.showDescriptions", false);

        for (const diagnostic of context.diagnostics) {
            // Every cursor move near a diagnostic re-requests code actions, so
            // the extraction below - which can reach the digest lookup - runs
            // once per diagnostic for requests already superseded. Stop before
            // paying it for a result the editor will discard.
            if (token.isCancellationRequested) {
                return undefined;
            }

            const suggestions = await this.importHandler.extractImportSuggestions(diagnostic.message, document.uri);

            if (suggestions.length === 0) {
                continue;
            }

            const sortedSuggestions = this.sortSuggestions(suggestions, sortAlphabetically);

            logger.debug("ImportCodeActionProvider", `Creating ${sortedSuggestions.length} quick fix action(s) for diagnostic`);

            sortedSuggestions.forEach((suggestion, index) => {
                const action = this.createQuickFixAction(
                    suggestion,
                    diagnostic,
                    document,
                    index === 0, // isPreferred
                    showDescriptions,
                );
                codeActions.push(action);
            });
        }

        return codeActions.length > 0 ? codeActions : undefined;
    }

    /**
     * A new array of the suggestions, alphabetized by statement or left in the
     * order the extractor produced them. The input is not modified.
     */
    private sortSuggestions(suggestions: ImportSuggestion[], sortAlphabetically: boolean): ImportSuggestion[] {
        const sorted = [...suggestions];

        if (sortAlphabetically) {
            sorted.sort((a, b) => a.importStatement.localeCompare(b.importStatement));
        }

        return sorted;
    }

    private createQuickFixAction(suggestion: ImportSuggestion, diagnostic: vscode.Diagnostic, document: vscode.TextDocument, isPreferred: boolean, showDescriptions: boolean): vscode.CodeAction {
        let title = `Add import: ${suggestion.importStatement}`;
        if (showDescriptions && suggestion.description) {
            title += ` (${suggestion.description})`;
        }

        if (showDescriptions && suggestion.confidence !== "high") {
            const indicator = suggestion.confidence === "medium" ? "[medium confidence]" : "[low confidence]";
            title = `${indicator} ${title}`;
        }

        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

        action.isPreferred = isPreferred;
        action.kind = vscode.CodeActionKind.QuickFix.append("verse.import");
        action.diagnostics = [diagnostic];

        // The diagnostic's line travels with the statement: placement reads it
        // to tell a pinned import that failed to resolve, and so needs this
        // import above it, from one that merely has the form of a consumer.
        action.command = {
            title: "Add Import",
            command: "verseAutoImports.addSingleImport",
            arguments: [document, suggestion.importStatement, diagnostic.range.start.line],
        };

        return action;
    }
}

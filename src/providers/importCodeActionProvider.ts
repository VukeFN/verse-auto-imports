import * as vscode from "vscode";
import { ImportHandler } from "../handlers/importHandler";
import { log } from "../utils/logging";

export class ImportCodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private importHandler: ImportHandler
    ) {}

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] | undefined {
        const codeActions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            const importStatement = this.importHandler.extractImportStatement(
                diagnostic.message
            );

            if (importStatement) {
                log(
                    this.outputChannel,
                    `Creating quick fix for: ${importStatement}`
                );

                const action = new vscode.CodeAction(
                    `✓ Add import: ${importStatement}`,
                    vscode.CodeActionKind.QuickFix
                );

                action.isPreferred = true;

                action.kind =
                    vscode.CodeActionKind.QuickFix.append("verse.import");

                action.diagnostics = [diagnostic];

                action.command = {
                    title: "Add Import",
                    command: "verseAutoImports.addSingleImport",
                    arguments: [document, importStatement],
                };

                codeActions.push(action);
            }
        }

        return codeActions;
    }
}

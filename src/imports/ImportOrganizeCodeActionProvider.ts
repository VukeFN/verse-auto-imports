import * as vscode from "vscode";
import { logger } from "../utils";

/**
 * Puts the extension's import organizing behind VS Code's own Organize Imports:
 * Shift+Alt+O, the Source Action menu, and `editor.codeActionsOnSave`.
 *
 * The action carries no edit of its own. Organizing rebuilds the whole import
 * block and adds whatever the current diagnostics report as missing, which is
 * the same work the Optimize Imports command does, so it is delegated to a
 * command rather than reimplemented as a workspace edit that would drift from
 * it.
 */
export class ImportOrganizeCodeActionProvider implements vscode.CodeActionProvider {
    /**
     * Declared to the registration so VS Code skips this provider whenever a
     * different kind is requested. Without it every quick-fix request would
     * also build this action.
     */
    static readonly providedCodeActionKinds: readonly vscode.CodeActionKind[] = [vscode.CodeActionKind.SourceOrganizeImports];

    /**
     * The organize action, always. A source action is only ever requested
     * explicitly, and organizing a block that is already organized is a no-op
     * the editor never sees, so there is nothing to withhold it for.
     */
    provideCodeActions(document: vscode.TextDocument): vscode.CodeAction[] {
        logger.debug("ImportOrganizeCodeActionProvider", "Offering the organize imports source action");

        const action = new vscode.CodeAction("Organize Imports", vscode.CodeActionKind.SourceOrganizeImports);

        action.command = {
            title: "Organize Imports",
            command: "verseAutoImports.organizeImportsInDocument",
            arguments: [document],
        };

        return [action];
    }
}

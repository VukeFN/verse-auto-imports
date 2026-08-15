import * as vscode from "vscode";
import { logger } from "../utils";
import { parseModuleVisibilityMessage } from "./ModuleVisibilityMessage";

/**
 * Offers a quick fix on the compiler error a `<public>` module declaration
 * fixes: an import that reaches an implicit folder module across project
 * branches, which is internal by default.
 *
 * The action carries no edit of its own. Which files change depends on what
 * the project already declares, which is a workspace scan, and a provider must
 * answer fast enough for a lightbulb.
 */
export class ModuleVisibilityCodeActionProvider implements vscode.CodeActionProvider {
    /**
     * Declared to the registration so VS Code skips this provider whenever a
     * kind outside quick fixes is requested.
     */
    static readonly providedCodeActionKinds: readonly vscode.CodeActionKind[] = [vscode.CodeActionKind.QuickFix];

    /**
     * One action per diagnostic that names an inaccessible internal module, or
     * undefined when none does.
     */
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] | undefined {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            const request = parseModuleVisibilityMessage(diagnostic.message);
            if (!request) {
                continue;
            }

            logger.debug("ModuleVisibilityCodeActionProvider", `Offering visibility fix for ${request.targetPath}`);

            const action = new vscode.CodeAction(`Make module '${request.moduleName}' public`, vscode.CodeActionKind.QuickFix);
            action.kind = vscode.CodeActionKind.QuickFix.append("verse.moduleVisibility");
            action.diagnostics = [diagnostic];
            // The document rides along because the request carries Verse paths
            // only, and the writer needs a URI to pick the workspace folder in
            // a multi-root workspace.
            action.command = {
                title: "Make Module Public",
                command: "verseAutoImports.makeModulePublic",
                arguments: [request, document.uri],
            };

            actions.push(action);
        }

        return actions.length > 0 ? actions : undefined;
    }
}

import * as vscode from 'vscode';
import { DiagnosticsHandler } from './handlers/diagnosticsHandler';
import { ImportHandler } from './handlers/importHandler';
import { CommandsHandler } from './handlers/commandsHandler';
import { setupLogging } from './utils/logging';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = setupLogging(context);
    const importHandler = new ImportHandler(outputChannel);
    const diagnosticsHandler = new DiagnosticsHandler(outputChannel);
    const commandsHandler = new CommandsHandler(outputChannel, importHandler);
    
    context.subscriptions.push(
        vscode.commands.registerCommand('verseAutoImports.optimizeImports', () => {
            commandsHandler.optimizeImports();
        }),
        vscode.languages.onDidChangeDiagnostics(async (e) => {
            for (const uri of e.uris) {
                const diagnostics = vscode.languages.getDiagnostics(uri);
                const document = await vscode.workspace.openTextDocument(uri);
                
                if (document.languageId === 'verse') {
                    const config = vscode.workspace.getConfiguration('verseAutoImports');
                    const autoImportEnabled = config.get('autoImport', true);

                    if (autoImportEnabled) {
                        await diagnosticsHandler.handle(document, diagnostics);
                    }
                }
            }
        })
    );
}

export function deactivate() {}
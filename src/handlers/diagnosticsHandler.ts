import * as vscode from 'vscode';
import { ImportHandler } from './importHandler';
import { ModuleHandler } from './moduleHandler';
import { log } from '../utils/logging';

export class DiagnosticsHandler {
    private importHandler: ImportHandler;
    private moduleHandler: ModuleHandler;
    
    constructor(private outputChannel: vscode.OutputChannel) {
        this.importHandler = new ImportHandler(outputChannel);
        this.moduleHandler = new ModuleHandler(outputChannel);
    }
    
    async handle(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]) {
        log(this.outputChannel, `Processing diagnostics for ${document.uri.toString()}`);
        const importStatements = new Set<string>();

        for (const diagnostic of diagnostics) {
            const importStatement = this.importHandler.extractImportStatement(diagnostic.message);
            if (importStatement) {
                importStatements.add(importStatement);
                continue;
            }

            await this.moduleHandler.handleModuleError(diagnostic, document);
        }

        if (importStatements.size > 0) {
            const editor = await vscode.window.showTextDocument(document);
            await this.importHandler.addImportsToDocument(editor, Array.from(importStatements));
        }
    }
}
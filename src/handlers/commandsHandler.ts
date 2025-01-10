import * as vscode from 'vscode';
import { log } from '../utils/logging';
import { ImportHandler } from './importHandler';

export class CommandsHandler {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private importHandler: ImportHandler
    ) {}

    async optimizeImports() {
        log(this.outputChannel, 'Optimizing imports command triggered');
        
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            log(this.outputChannel, 'No active editor found');
            vscode.window.showWarningMessage('Please open a file to optimize imports');
            return;
        }

        if (editor.document.languageId !== 'verse') {
            log(this.outputChannel, 'Active file is not a Verse file');
            vscode.window.showWarningMessage('Optimize imports only works with Verse files');
            return;
        }

        try {
            const existingImports = this.importHandler.extractExistingImports(editor.document);
            log(this.outputChannel, `Found ${existingImports.length} imports to optimize`);
            
            await this.importHandler.addImportsToDocument(editor, existingImports);
            
            log(this.outputChannel, 'Successfully optimized imports');
            vscode.window.showInformationMessage('Imports optimized successfully');
        } catch (error) {
            log(this.outputChannel, `Error optimizing imports: ${error}`);
            vscode.window.showErrorMessage('Failed to optimize imports');
        }
    }
}
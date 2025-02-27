import * as vscode from 'vscode';
import { log } from '../utils/logging';

export class ImportHandler {
    extractExistingImports(document: vscode.TextDocument): string[] {
        log(this.outputChannel, 'Extracting existing imports from document');
        const text = document.getText();
        const lines = text.split('\n');
        const imports = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('using {')) {
                log(this.outputChannel, `Found import: ${trimmed}`);
                imports.add(trimmed);
            }
        }

        log(this.outputChannel, `Extracted ${imports.size} existing imports`);
        return Array.from(imports);
    }
    constructor(private outputChannel: vscode.OutputChannel) {}
    
    extractImportStatement(errorMessage: string): string | null {
        log(this.outputChannel, `Extracting import statement from error: ${errorMessage}`);
        
        // Pattern 1: Existing pattern
        let match = errorMessage.match(/Did you forget to specify (using \{ \/[^}]+ \})\?/);
        if (match) {
            log(this.outputChannel, `Found import statement: ${match[1]}`);
            return match[1];
        }
        
        // Pattern 2: New pattern for custom using, e.g. "Did you mean `Utils.Format`?"
        match = errorMessage.match(/Did you mean `([^`]+)\.[^`]+`\?/);
        if (match) {
            const namespace = match[1];
            const importStatement = `using { ${namespace} }`;
            log(this.outputChannel, `Inferred import statement: ${importStatement}`);
            return importStatement;
        }
        
        log(this.outputChannel, 'No import statement found in error message');
        return null;
    }
    

    async addImportsToDocument(editor: vscode.TextEditor, importStatements: string[]) {
        log(this.outputChannel, `Adding ${importStatements.length} import statements to document`);
        const document = editor.document;
        const text = document.getText();
        const lines = text.split('\n');
            
        const existingImports = new Set<string>();
        const importLines: number[] = [];
            
        log(this.outputChannel, 'Scanning document for existing imports...');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('using {')) {
                log(this.outputChannel, `Found existing import at line ${i}: ${line}`);
                existingImports.add(line);
                importLines.push(i);
            }
        }
        log(this.outputChannel, `Found ${existingImports.size} existing imports`);
            
        const allImports = new Set([...existingImports]);
        for (const importStatement of importStatements) {
            if (!existingImports.has(importStatement)) {
                log(this.outputChannel, `Adding new import: ${importStatement}`);
                allImports.add(importStatement);
            } else {
                log(this.outputChannel, `Skipping duplicate import: ${importStatement}`);
            }
        }
            
        log(this.outputChannel, 'Sorting imports alphabetically...');
        const sortedImports = Array.from(allImports).sort((a, b) => {
            const pathA = a.match(/using \{ (\/[^}]+) \}/)?.[1] || '';
            const pathB = b.match(/using \{ (\/[^}]+) \}/)?.[1] || '';
            return pathA.localeCompare(pathB);
        });
        log(this.outputChannel, `Total imports after sorting: ${sortedImports.length}`);
            
        try {
            await editor.edit(editBuilder => {
                if (importLines.length > 0) {
                    log(this.outputChannel, `Replacing existing imports block (lines ${Math.min(...importLines)}-${Math.max(...importLines)})`);
                    const startLine = Math.min(...importLines);
                    const endLine = Math.max(...importLines);
                    const start = new vscode.Position(startLine, 0);
                    const end = new vscode.Position(endLine + 1, 0);
                    
                    editBuilder.replace(
                        new vscode.Range(start, end),
                        sortedImports.join('\n') + '\n'
                    );
                } else {
                    log(this.outputChannel, 'No existing imports found, adding at start of file');
                    editBuilder.insert(
                        new vscode.Position(0, 0),
                        sortedImports.join('\n') + '\n'
                    );
                }
            });
            log(this.outputChannel, 'Successfully updated imports in document');
        } catch (error) {
            log(this.outputChannel, `Error updating imports: ${error}`);
            throw error;
        }
    }
}
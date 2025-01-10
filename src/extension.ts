import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('verse');
    context.subscriptions.push(diagnosticCollection);

    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(async (e) => {
            for (const uri of e.uris) {
                const diagnostics = vscode.languages.getDiagnostics(uri);
                const document = await vscode.workspace.openTextDocument(uri);
                
                if (document.languageId === 'verse') {
                    const config = vscode.workspace.getConfiguration('verseAutoImports');
                    const autoImportEnabled = config.get('autoImport', true);

                    if (autoImportEnabled) {
                        await handleDiagnostics(document, diagnostics);
                    }
                }
            }
        })
    );
}

async function handleDiagnostics(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]) {
    const importStatements = new Set<string>();

    for (const diagnostic of diagnostics) {
        const importStatement = extractImportStatement(diagnostic.message);
        if (importStatement) {
            importStatements.add(importStatement);
        }
    }

    if (importStatements.size > 0) {
        const editor = await vscode.window.showTextDocument(document);
        await addImportsToDocument(editor, Array.from(importStatements));
    }
}

function extractImportStatement(errorMessage: string): string | null {
    const match = errorMessage.match(/Did you forget to specify (using \{ \/[^}]+ \})\?/);
    if (match) {
        return match[1];
    }
    return null;
}

async function addImportsToDocument(editor: vscode.TextEditor, importStatements: string[]) {
    const document = editor.document;
    const text = document.getText();

    await editor.edit(editBuilder => {
        let insertPosition = new vscode.Position(0, 0);
        const lines = text.split('\n');
        let lastUsingIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('using {')) {
                lastUsingIndex = i;
            }
        }

        insertPosition = new vscode.Position(lastUsingIndex + 1, 0);
        
        for (const importStatement of importStatements) {
            if (!text.includes(importStatement)) {
                editBuilder.insert(insertPosition, importStatement + '\n');
            }
        }
    });
}

export function deactivate() {}
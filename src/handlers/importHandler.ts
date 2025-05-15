import * as vscode from "vscode";
import { log } from "../utils/logging";

export class ImportHandler {
    constructor(private outputChannel: vscode.OutputChannel) {}

    extractExistingImports(document: vscode.TextDocument): string[] {
        log(this.outputChannel, "Extracting existing imports from document");
        const text = document.getText();
        const lines = text.split("\n");
        const imports = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("using")) {
                log(this.outputChannel, `Found import: ${trimmed}`);
                imports.add(trimmed);
            }
        }

        log(this.outputChannel, `Extracted ${imports.size} existing imports`);
        return Array.from(imports);
    }

    extractImportStatement(errorMessage: string): string | null {
        log(this.outputChannel, `Extracting import statement from error: ${errorMessage}`);

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax = config.get<string>("importSyntax", "curly") === "dot";
        const ambiguousImportMappings = config.get<Record<string, string>>("ambiguousImports", {});

        const classNameMatch = errorMessage.match(/Unknown identifier `([^`]+)`/);
        if (classNameMatch) {
            const className = classNameMatch[1];

            if (ambiguousImportMappings[className]) {
                const preferredPath = ambiguousImportMappings[className];
                const importStatement = this.formatImportStatement(preferredPath, preferDotSyntax);

                log(this.outputChannel, `Using configured path for ambiguous class ${className}: ${importStatement}`);
                return importStatement;
            }
        }

        // Pattern 1: "Did you forget to specify using { /Path }"
        let match = errorMessage.match(/Did you forget to specify (using \{ \/[^}]+ \})/);
        if (match) {
            const path = match[1].match(/using \{ (\/[^}]+) \}/)?.[1];
            if (path) {
                const importStatement = this.formatImportStatement(path, preferDotSyntax);
                log(this.outputChannel, `Found import statement: ${importStatement}`);
                return importStatement;
            }
        }

        // Pattern 2: "Did you mean Namespace.Component"
        match = errorMessage.match(/Did you mean ([^`]+)/);
        if (match) {
            const fullName = match[1];
            const lastDotIndex = fullName.lastIndexOf(".");
            log(this.outputChannel, `Last dot index: ${lastDotIndex}`);
            if (lastDotIndex > 0) {
                const namespace = fullName.substring(0, lastDotIndex);
                const importStatement = this.formatImportStatement(namespace, preferDotSyntax);
                log(this.outputChannel, `Inferred import statement: ${importStatement}`);
                return importStatement;
            }
        }

        log(this.outputChannel, "No import statement found in error message");
        return null;
    }

    async addImportsToDocument(document: vscode.TextDocument, importStatements: string[]): Promise<boolean> {
        log(this.outputChannel, `Adding ${importStatements.length} import statements to document`);

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax = config.get<string>("importSyntax", "curly") === "dot";
        const preserveImportLocations = config.get<boolean>("preserveImportLocations", false);

        log(
            this.outputChannel,
            `Import statements received:${preserveImportLocations ? " (locations will be preserved)" : ""}`
        );
        importStatements.forEach((statement) => {
            log(this.outputChannel, `- ${statement}`);
        });

        const text = document.getText();
        const lines = text.split("\n");
        const existingImports = new Set<string>();

        const importBlocks: { start: number; end: number; imports: string[] }[] = [];
        let currentBlock: { start: number; end: number; imports: string[] } | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("using")) {
                log(this.outputChannel, `Found existing import at line ${i}: ${line}`);

                existingImports.add(line);

                if (!currentBlock) {
                    currentBlock = { start: i, end: i, imports: [line] };
                } else if (i === currentBlock.end + 1 || (i === currentBlock.end + 2 && lines[i - 1].trim() === "")) {
                    currentBlock.end = i;
                    currentBlock.imports.push(line);
                } else {
                    importBlocks.push(currentBlock);
                    currentBlock = { start: i, end: i, imports: [line] };
                }
            }
        }

        if (currentBlock) {
            importBlocks.push(currentBlock);
        }

        log(this.outputChannel, `Found ${existingImports.size} existing imports in ${importBlocks.length} blocks`);

        const existingPaths = new Set<string>();
        existingImports.forEach((imp) => {
            const path = this.extractPathFromImport(imp);
            if (path) {
                existingPaths.add(path);
            }
        });

        const newImportPaths = new Set<string>();
        importStatements.forEach((imp) => {
            const path = this.extractPathFromImport(imp);
            if (path && !existingPaths.has(path)) {
                log(this.outputChannel, `New import needed: ${path}`);
                newImportPaths.add(path);
            }
        });

        if (newImportPaths.size === 0) {
            log(this.outputChannel, "No new imports needed, skipping update");
            return true;
        }

        const edit = new vscode.WorkspaceEdit();

        if (preserveImportLocations) {
            const newImports = Array.from(newImportPaths).map((path) =>
                this.formatImportStatement(path, preferDotSyntax)
            );

            newImports.sort();

            if (importBlocks.length > 0 && importBlocks[0].start === 0) {
                edit.insert(
                    document.uri,
                    new vscode.Position(importBlocks[0].end + 1, 0),
                    newImports.join("\n") + "\n"
                );
            } else {
                edit.insert(document.uri, new vscode.Position(0, 0), newImports.join("\n") + "\n\n");
            }
        } else {
            const allPaths = new Set<string>([...existingPaths, ...newImportPaths]);
            const sortedImports = Array.from(allPaths)
                .sort((a, b) => a.localeCompare(b))
                .map((path) => this.formatImportStatement(path, preferDotSyntax));

            edit.insert(document.uri, new vscode.Position(0, 0), sortedImports.join("\n") + "\n\n");

            for (let i = importBlocks.length - 1; i >= 0; i--) {
                const block = importBlocks[i];
                edit.delete(
                    document.uri,
                    new vscode.Range(new vscode.Position(block.start, 0), new vscode.Position(block.end + 1, 0))
                );
            }
        }

        try {
            const success = await vscode.workspace.applyEdit(edit);
            log(
                this.outputChannel,
                success ? "Successfully updated imports in document" : "Failed to update imports in document"
            );
            return success;
        } catch (error) {
            log(this.outputChannel, `Error updating imports: ${error}`);
            return false;
        }
    }

    private formatImportStatement(path: string, useDotSyntax: boolean): string {
        return useDotSyntax ? `using. ${path.trim()}` : `using { ${path.trim()} }`;
    }

    private extractPathFromImport(importStatement: string): string | null {
        const curlyMatch = importStatement.match(/using\s*\{\s*([^}]+)\s*\}/);
        if (curlyMatch) {
            return curlyMatch[1].trim();
        }

        const dotMatch = importStatement.match(/using\.\s*(.+)/);
        if (dotMatch) {
            return dotMatch[1].trim();
        }

        return null;
    }
}

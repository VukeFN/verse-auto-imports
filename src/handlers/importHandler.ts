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
        log(
            this.outputChannel,
            `Extracting import statement from error: ${errorMessage}`
        );

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax =
            config.get<string>("importSyntax", "curly") === "dot";
        const ambiguousImportMappings = config.get<Record<string, string>>(
            "ambiguousImports",
            {}
        );

        const classNameMatch = errorMessage.match(
            /Unknown identifier `([^`]+)`/
        );
        if (classNameMatch) {
            const className = classNameMatch[1];

            if (ambiguousImportMappings[className]) {
                const preferredPath = ambiguousImportMappings[className];
                const importStatement = this.formatImportStatement(
                    preferredPath,
                    preferDotSyntax
                );

                log(
                    this.outputChannel,
                    `Using configured path for ambiguous class ${className}: ${importStatement}`
                );
                return importStatement;
            }
        }

        // Pattern 1: "Did you forget to specify using { /Path }?"
        let match = errorMessage.match(
            /Did you forget to specify (using \{ \/[^}]+ \})\?/
        );
        if (match) {
            const path = match[1].match(/using \{ (\/[^}]+) \}/)?.[1];
            if (path) {
                const importStatement = this.formatImportStatement(
                    path,
                    preferDotSyntax
                );
                log(
                    this.outputChannel,
                    `Found import statement: ${importStatement}`
                );
                return importStatement;
            }
        }

        // Pattern 2: "Did you mean `Namespace.Component`?"
        match = errorMessage.match(/Did you mean `([^`]+)`\?/);
        if (match) {
            const fullName = match[1];
            const lastDotIndex = fullName.lastIndexOf(".");
            if (lastDotIndex > 0) {
                const namespace = fullName.substring(0, lastDotIndex);
                const importStatement = this.formatImportStatement(
                    namespace,
                    preferDotSyntax
                );
                log(
                    this.outputChannel,
                    `Inferred import statement: ${importStatement}`
                );
                return importStatement;
            }
        }

        log(this.outputChannel, "No import statement found in error message");
        return null;
    }

    async addImportsToDocument(
        document: vscode.TextDocument,
        importStatements: string[]
    ): Promise<boolean> {
        log(
            this.outputChannel,
            `Adding ${importStatements.length} import statements to document`
        );

        log(this.outputChannel, `Import statements received:`);
        importStatements.forEach((statement) => {
            log(this.outputChannel, `- ${statement}`);
        });

        const text = document.getText();
        const lines = text.split("\n");
        const existingImports = new Set<string>();
        const importLines: number[] = [];

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax =
            config.get<string>("importSyntax", "curly") === "dot";

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("using")) {
                log(
                    this.outputChannel,
                    `Found existing import at line ${i}: ${line}`
                );
                existingImports.add(line);
                importLines.push(i);
            }
        }

        log(
            this.outputChannel,
            `Found ${existingImports.size} existing imports`
        );

        const allImportPaths = new Set<string>();
        let formatUpdateNeeded = false;

        existingImports.forEach((imp) => {
            const path = this.extractPathFromImport(imp);
            if (path) {
                const isDotFormat = imp.startsWith("using.");
                if (preferDotSyntax !== isDotFormat) {
                    formatUpdateNeeded = true;
                    log(this.outputChannel, `Format update needed for: ${imp}`);
                }
                allImportPaths.add(path);
            }
        });

        let newImportsAdded = false;
        importStatements.forEach((imp) => {
            const path = this.extractPathFromImport(imp);
            if (path) {
                const alreadyExists = Array.from(existingImports).some(
                    (existingImp) =>
                        this.extractPathFromImport(existingImp) === path
                );

                if (!alreadyExists) {
                    log(this.outputChannel, `Adding new import path: ${path}`);
                    allImportPaths.add(path);
                    newImportsAdded = true;
                } else {
                    log(
                        this.outputChannel,
                        `Skipping duplicate import path: ${path}`
                    );
                }
            }
        });

        if (
            !newImportsAdded &&
            !formatUpdateNeeded &&
            existingImports.size > 0
        ) {
            log(
                this.outputChannel,
                `No changes needed, skipping document update`
            );
            return true;
        }

        const sortedPaths = Array.from(allImportPaths).sort((a, b) =>
            a.localeCompare(b)
        );

        const sortedImports = sortedPaths.map((path) => {
            return this.formatImportStatement(path, preferDotSyntax);
        });

        const edit = new vscode.WorkspaceEdit();

        if (importLines.length > 0) {
            const startLine = Math.min(...importLines);
            const endLine = Math.max(...importLines);
            const start = new vscode.Position(startLine, 0);
            const end = new vscode.Position(endLine + 1, 0);

            edit.replace(
                document.uri,
                new vscode.Range(start, end),
                sortedImports.join("\n") + "\n"
            );
        } else {
            edit.insert(
                document.uri,
                new vscode.Position(0, 0),
                sortedImports.join("\n") + "\n"
            );
        }

        try {
            const success = await vscode.workspace.applyEdit(edit);
            log(
                this.outputChannel,
                success
                    ? "Successfully updated imports in document"
                    : "Failed to update imports in document"
            );
            return success;
        } catch (error) {
            log(this.outputChannel, `Error updating imports: ${error}`);
            return false;
        }
    }

    private formatImportStatement(path: string, useDotSyntax: boolean): string {
        return useDotSyntax
            ? `using. ${path.trim()}`
            : `using { ${path.trim()} }`;
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

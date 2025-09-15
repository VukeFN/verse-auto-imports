import * as vscode from "vscode";
import { log } from "../utils/logging";
import { ImportSuggestion, ImportSuggestionSource, ImportConfidence } from "../types/moduleInfo";
import { DigestParser, DigestEntry } from "../utils/digestParser";

export class ImportHandler {
    private digestParser: DigestParser;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.digestParser = new DigestParser(outputChannel);
    }

    private parseMultiOptionSuggestions(errorMessage: string): string[] {
        const multiOptionPattern = /Did you mean any of:\s*\n(.+)/s;
        const match = errorMessage.match(multiOptionPattern);

        if (!match) {
            return [];
        }

        const optionsText = match[1];
        // Split by newlines and filter out empty lines
        const options = optionsText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        log(this.outputChannel, `Found ${options.length} multi-options: ${options.join(', ')}`);
        return options;
    }

    private selectBestOption(options: string[]): string {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const strategy = config.get<string>("multiOptionStrategy", "auto_shortest");

        switch (strategy) {
            case "auto_shortest":
                // Return the option with the shortest path
                return options.reduce((shortest, current) =>
                    current.length < shortest.length ? current : shortest
                );
            case "auto_first":
                return options[0];
            default:
                return options[0]; // fallback
        }
    }

    private createImportSuggestion(
        importStatement: string,
        source: ImportSuggestionSource,
        confidence: ImportConfidence,
        description?: string
    ): ImportSuggestion {
        const modulePath = this.extractPathFromImport(importStatement);
        return {
            importStatement,
            source,
            confidence,
            description,
            modulePath: modulePath || undefined
        };
    }

    private async lookupIdentifierInDigest(identifier: string): Promise<ImportSuggestion[]> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const useDigestFiles = config.get<boolean>("useDigestFiles", false);
        const preferDotSyntax = config.get<string>("importSyntax", "curly") === "dot";

        if (!useDigestFiles) {
            return [];
        }

        try {
            const digestEntries = await this.digestParser.lookupIdentifier(identifier);
            const suggestions: ImportSuggestion[] = [];

            for (const entry of digestEntries) {
                if (!entry.modulePath) {
                    continue;
                }

                const importStatement = this.formatImportStatement(entry.modulePath, preferDotSyntax);
                const confidence: ImportConfidence = entry.identifier === identifier ? 'high' : 'medium';
                const description = `${entry.type} from ${entry.modulePath}`;

                suggestions.push(this.createImportSuggestion(
                    importStatement,
                    'digest_lookup',
                    confidence,
                    description
                ));
            }

            if (suggestions.length > 0) {
                log(this.outputChannel, `Found ${suggestions.length} digest-based suggestions for: ${identifier}`);
            }

            return suggestions;
        } catch (error) {
            log(this.outputChannel, `Error looking up identifier in digest: ${error}`);
            return [];
        }
    }

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

    async extractImportSuggestions(errorMessage: string): Promise<ImportSuggestion[]> {
        log(this.outputChannel, `Extracting import suggestions from error: ${errorMessage}`);

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const preferDotSyntax = config.get<string>("importSyntax", "curly") === "dot";
        const ambiguousImportMappings = config.get<Record<string, string>>("ambiguousImports", {});

        // Check for multi-option "Did you mean any of" pattern first
        const multiOptions = this.parseMultiOptionSuggestions(errorMessage);
        if (multiOptions.length > 0) {
            log(this.outputChannel, `Found multi-option pattern with ${multiOptions.length} options`);
            const suggestions: ImportSuggestion[] = [];

            for (const option of multiOptions) {
                const lastDotIndex = option.lastIndexOf(".");
                if (lastDotIndex > 0) {
                    const namespace = option.substring(0, lastDotIndex);
                    const className = option.substring(lastDotIndex + 1);
                    const importStatement = this.formatImportStatement(namespace, preferDotSyntax);

                    log(this.outputChannel, `Multi-option: ${option} -> namespace: ${namespace}, class: ${className}`);

                    suggestions.push(this.createImportSuggestion(
                        importStatement,
                        'error_message',
                        'high',
                        `${className} from ${namespace}`
                    ));
                } else {
                    // If no namespace, the option might be a direct module reference
                    const importStatement = this.formatImportStatement(option, preferDotSyntax);
                    log(this.outputChannel, `Multi-option (no namespace): ${option}`);

                    suggestions.push(this.createImportSuggestion(
                        importStatement,
                        'error_message',
                        'medium',
                        `Import ${option}`
                    ));
                }
            }

            return suggestions;
        }

        // Check for unknown identifier with ambiguous mapping or digest lookup
        const classNameMatch = errorMessage.match(/Unknown identifier `([^`]+)`/);
        if (classNameMatch) {
            const className = classNameMatch[1];

            // First check configured ambiguous mappings
            if (ambiguousImportMappings[className]) {
                const preferredPath = ambiguousImportMappings[className];
                const importStatement = this.formatImportStatement(preferredPath, preferDotSyntax);

                log(this.outputChannel, `Using configured path for ambiguous class ${className}: ${importStatement}`);
                return [this.createImportSuggestion(
                    importStatement,
                    'error_message',
                    'high',
                    `Configured import for ${className}`
                )];
            }

            // Try digest-based lookup for unknown identifier
            const digestSuggestions = await this.lookupIdentifierInDigest(className);
            if (digestSuggestions.length > 0) {
                log(this.outputChannel, `Found digest-based suggestions for unknown identifier: ${className}`);
                return digestSuggestions;
            }
        }

        // Pattern 1: "Did you forget to specify using { /Path }"
        let match = errorMessage.match(/Did you forget to specify (using \{ \/[^}]+ \})/);
        if (match) {
            const path = match[1].match(/using \{ (\/[^}]+) \}/)?.[1];
            if (path) {
                const importStatement = this.formatImportStatement(path, preferDotSyntax);
                log(this.outputChannel, `Found import statement: ${importStatement}`);
                return [this.createImportSuggestion(
                    importStatement,
                    'error_message',
                    'high',
                    `Standard import for ${path}`
                )];
            }
        }

        // Pattern 2: "Did you mean Namespace.Component" (single option)
        match = errorMessage.match(/Did you mean ([^`\n]+)/);
        if (match) {
            const fullName = match[1].trim();
            const lastDotIndex = fullName.lastIndexOf(".");
            log(this.outputChannel, `Last dot index: ${lastDotIndex} for ${fullName}`);
            if (lastDotIndex > 0) {
                const namespace = fullName.substring(0, lastDotIndex);
                const importStatement = this.formatImportStatement(namespace, preferDotSyntax);
                log(this.outputChannel, `Inferred import statement: ${importStatement}`);
                return [this.createImportSuggestion(
                    importStatement,
                    'error_message',
                    'high',
                    `Inferred import for ${fullName}`
                )];
            }
        }

        log(this.outputChannel, "No import suggestions found in error message");
        return [];
    }

    // Keep the old method for backward compatibility temporarily
    async extractImportStatement(errorMessage: string): Promise<string | null> {
        const suggestions = await this.extractImportSuggestions(errorMessage);
        if (suggestions.length > 0) {
            // For backward compatibility, return the first suggestion's import statement
            return suggestions[0].importStatement;
        }
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
            // Consolidate all imports at the top
            const allPaths = new Set<string>([...existingPaths, ...newImportPaths]);
            const sortedImports = Array.from(allPaths)
                .sort((a, b) => a.localeCompare(b))
                .map((path) => this.formatImportStatement(path, preferDotSyntax));

            // Determine the line after all existing import blocks to check for spacing
            let lineAfterImports = 0;
            if (importBlocks.length > 0) {
                lineAfterImports = Math.max(...importBlocks.map(block => block.end)) + 1;
            }

            // Check if there's already an empty line after imports
            let needsEmptyLine = true;
            if (lineAfterImports < lines.length) {
                const lineAfter = lines[lineAfterImports];
                // If the line after imports is empty, we don't need to add another empty line
                if (lineAfter && lineAfter.trim() === "") {
                    needsEmptyLine = false;
                } else if (lineAfterImports === lines.length - 1 || !lineAfter) {
                    // If we're at the end of file or no content after, we still want the empty line
                    needsEmptyLine = true;
                }
            }

            // Insert sorted imports at top with appropriate spacing
            const importsText = sortedImports.join("\n") + "\n" + (needsEmptyLine ? "\n" : "");
            edit.insert(document.uri, new vscode.Position(0, 0), importsText);

            // Remove existing import blocks (in reverse order to maintain line numbers)
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

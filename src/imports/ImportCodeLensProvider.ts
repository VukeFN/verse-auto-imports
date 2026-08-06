import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportPathConverter } from "./ImportPathConverter";
import { scanConvertibleImports } from "./ImportScanner";

/** Tracks hover state for a document's imports. */
interface HoverState {
    lineNumber: number;
    timeout: NodeJS.Timeout | null;
}

export class ImportCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private readonly importPathConverter: ImportPathConverter;
    private readonly hoverState = new Map<string, HoverState>();
    private readonly isHoveringImport = new Map<string, boolean>();
    private refreshTimeout: NodeJS.Timeout | null = null;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.importPathConverter = new ImportPathConverter(outputChannel);

        // Watch for configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("verseAutoImports.pathConversion")) {
                this._onDidChangeCodeLenses.fire();
            }
        });

        // Watch for document changes to refresh CodeLens immediately
        vscode.workspace.onDidChangeTextDocument((e) => {
            // Only refresh for Verse files that are currently showing CodeLens
            if (e.document.languageId === "verse" && this.isHoveringImport.get(e.document.uri.toString())) {
                // Clear any pending refresh
                if (this.refreshTimeout) {
                    clearTimeout(this.refreshTimeout);
                    this.refreshTimeout = null;
                }

                // Single immediate refresh
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    /** Gets the configured hide delay in milliseconds */
    private getHideDelay(): number {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        return config.get<number>("pathConversion.codeLensHideDelay", 1000);
    }

    /** Gets the visibility mode setting */
    private getVisibilityMode(): "hover" | "always" {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        return config.get<"hover" | "always">("pathConversion.codeLensVisibility", "hover");
    }

    /**
     * Sets the hover state for a document
     */
    setHoverState(documentUri: string, hovering: boolean, lineNumber?: number): void {
        // In "always" mode, hover state management is not needed
        if (this.getVisibilityMode() === "always") {
            return;
        }

        const currentState = this.hoverState.get(documentUri);

        if (hovering && lineNumber !== undefined) {
            // Clear existing timeout if any
            if (currentState?.timeout) {
                clearTimeout(currentState.timeout);
            }

            this.hoverState.set(documentUri, {
                lineNumber,
                timeout: null,
            });
            this.isHoveringImport.set(documentUri, true);
            this._onDidChangeCodeLenses.fire();
        } else if (!hovering) {
            // Set timeout to hide CodeLens after configured delay
            if (currentState?.timeout) {
                clearTimeout(currentState.timeout);
            }

            const hideDelay = this.getHideDelay();
            const timeout = setTimeout(() => {
                this.isHoveringImport.set(documentUri, false);
                this.hoverState.delete(documentUri);
                this._onDidChangeCodeLenses.fire();
            }, hideDelay);

            if (currentState) {
                this.hoverState.set(documentUri, {
                    ...currentState,
                    timeout,
                });
            }
        }
    }

    /**
     * Keeps the hover state active (used during conversions)
     */
    keepHoverStateActive(documentUri: string): void {
        const currentState = this.hoverState.get(documentUri);

        // Clear any pending timeout
        if (currentState?.timeout) {
            clearTimeout(currentState.timeout);
        }

        // Keep the hover state active
        this.isHoveringImport.set(documentUri, true);

        // Single immediate refresh
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];

        // Check if CodeLens is enabled in configuration
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const showCodeLens = config.get<boolean>("pathConversion.enableCodeLens", true);

        if (!showCodeLens) {
            return codeLenses;
        }

        // Check visibility mode
        const visibilityMode = this.getVisibilityMode();
        const documentUri = document.uri.toString();

        // In "hover" mode, only show CodeLens if hovering over imports
        if (visibilityMode === "hover") {
            const isHovering = this.isHoveringImport.get(documentUri);
            if (!isHovering) {
                return codeLenses;
            }
        }

        const text = document.getText();
        const lines = text.split("\n");

        // Membership is the shared scanner's call, not this provider's: a lens
        // must appear on exactly the lines a conversion would act on, which
        // excludes a `using` inside a block comment or a module body.
        const convertibleImports = scanConvertibleImports(lines);

        // Whether a "for all" lens is worth offering is a property of the file,
        // not of the import the lens hangs off, so both counts are taken once.
        const hasMultipleFullPathImports =
            convertibleImports.filter(({ statement }) => this.importPathConverter.isFullPathImport(statement) && !this.importPathConverter.isBuiltinModule(statement)).length > 1;
        const hasMultipleRelativeImports = convertibleImports.filter(({ statement }) => !this.importPathConverter.isFullPathImport(statement)).length > 1;

        for (const { statement: trimmedLine, line: i } of convertibleImports) {
            const range = new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, lines[i].length));

            // Check if it's a full path import that can be converted to relative
            if (this.importPathConverter.isFullPathImport(trimmedLine)) {
                // Only show relative conversion for non-built-in modules
                if (!this.importPathConverter.isBuiltinModule(trimmedLine)) {
                    const moduleName = this.importPathConverter.extractModuleName(trimmedLine);

                    if (moduleName) {
                        // Create CodeLens for converting to relative path
                        const convertToRelativeLens = new vscode.CodeLens(range, {
                            title: `$(arrow-both)  Use relative path`,
                            tooltip: `Use relative path for '${moduleName}'`,
                            command: "verseAutoImports.convertToRelativePath",
                            arguments: [document, trimmedLine, i],
                        });
                        codeLenses.push(convertToRelativeLens);

                        // Add "Use relative paths for all" option if there are multiple full path imports
                        if (hasMultipleFullPathImports) {
                            const convertAllRelativeLens = new vscode.CodeLens(range, {
                                title: `$(arrow-swap)  Use relative paths for all`,
                                tooltip: "Use relative paths for all imports in this file",
                                command: "verseAutoImports.convertAllToRelativePath",
                                arguments: [document],
                            });
                            codeLenses.push(convertAllRelativeLens);
                        }
                    }
                }
            } else {
                // It's a relative import - show option to convert to absolute path
                const moduleName = this.importPathConverter.extractModuleName(trimmedLine);

                if (moduleName) {
                    // Create CodeLens for converting to absolute path
                    const convertSingleLens = new vscode.CodeLens(range, {
                        title: `$(arrow-both)  Use absolute path`,
                        tooltip: `Use absolute path for '${moduleName}'`,
                        command: "verseAutoImports.convertToFullPath",
                        arguments: [document, trimmedLine, i],
                    });
                    codeLenses.push(convertSingleLens);

                    // Add "Use absolute paths for all" option if there are multiple relative imports
                    if (hasMultipleRelativeImports) {
                        const convertAllLens = new vscode.CodeLens(range, {
                            title: `$(arrow-swap)  Use absolute paths for all`,
                            tooltip: "Use absolute paths for all imports in this file",
                            command: "verseAutoImports.convertAllToFullPath",
                            arguments: [document],
                        });
                        codeLenses.push(convertAllLens);
                    }
                }
            }
        }

        logger.debug("ImportCodeLensProvider", `Provided ${codeLenses.length} CodeLens items for ${document.fileName}`);
        return codeLenses;
    }

    resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
        // We already set the command in provideCodeLenses, so just return the same CodeLens
        return codeLens;
    }

    /**
     * Refresh CodeLens display
     */
    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Force immediate refresh after conversion (called after document edit)
     */
    forceRefreshAfterConversion(documentUri: string): void {
        // Ensure hover state remains active
        this.isHoveringImport.set(documentUri, true);

        // Single immediate refresh - VS Code handles the timing
        this._onDidChangeCodeLenses.fire();
    }
}

import * as vscode from "vscode";
import { logger } from "../utils";
import { ImportPathConverter } from "./ImportPathConverter";
import { LINE_SPLIT, scanConvertibleImports } from "./ImportScanner";

/**
 * The path-conversion lenses on a document's import lines, and the hover state
 * that decides whether they are shown at all.
 *
 * Hover state is per document uri, because the same provider serves every open
 * Verse file and a lens shown in one must not follow the user into another.
 */
export class ImportCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private readonly importPathConverter: ImportPathConverter;
    /** The pending hide timer per document; an entry exists only while one is armed. */
    private readonly hideTimers = new Map<string, NodeJS.Timeout>();
    private readonly isHoveringImport = new Map<string, boolean>();
    private refreshTimeout: NodeJS.Timeout | null = null;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private outputChannel: vscode.OutputChannel) {
        this.importPathConverter = new ImportPathConverter(outputChannel);

        // Both listeners are kept rather than discarded: onDidChangeTextDocument
        // fires on every keystroke in every document in the window, so one left
        // registered past deactivation keeps calling into a dead provider.
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("verseAutoImports.pathConversion")) {
                    this._onDidChangeCodeLenses.fire();
                }
            }),

            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId === "verse" && this.isHoveringImport.get(e.document.uri.toString())) {
                    if (this.refreshTimeout) {
                        clearTimeout(this.refreshTimeout);
                        this.refreshTimeout = null;
                    }

                    this._onDidChangeCodeLenses.fire();
                }
            }),
        );
    }

    /** The configured delay before the lenses are hidden, in milliseconds. */
    private getHideDelay(): number {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        return config.get<number>("pathConversion.codeLensHideDelay", 1000);
    }

    private getVisibilityMode(): "hover" | "always" {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        return config.get<"hover" | "always">("pathConversion.codeLensVisibility", "hover");
    }

    /**
     * Shows the lenses for a document at once, or schedules them to be hidden
     * once the hide delay elapses. A no-op in "always" mode, where visibility
     * does not follow the pointer.
     *
     * @param lineNumber The hovered line. Only its presence is read: it is what
     *   marks the hover as landing on an import, and a `hovering` call without
     *   one leaves the state as it was.
     */
    setHoverState(documentUri: string, hovering: boolean, lineNumber?: number): void {
        if (this.getVisibilityMode() === "always") {
            return;
        }

        if (hovering && lineNumber !== undefined) {
            this.clearPendingHide(documentUri);

            this.isHoveringImport.set(documentUri, true);
            this._onDidChangeCodeLenses.fire();
        } else if (!hovering) {
            this.clearPendingHide(documentUri);

            const hideDelay = this.getHideDelay();
            const timeout = setTimeout(() => {
                this.isHoveringImport.set(documentUri, false);
                this.hideTimers.delete(documentUri);
                this._onDidChangeCodeLenses.fire();
            }, hideDelay);

            // An armed timer left out of the map is one nothing can clear
            // afterwards - not clearPendingHide, and not dispose. The commonest
            // caller is the hover provider reporting a non-import line, which
            // reaches here with nothing stored at all.
            this.hideTimers.set(documentUri, timeout);
        }
    }

    /** Cancels a document's pending hide, and drops the entry that held it. */
    private clearPendingHide(documentUri: string): void {
        const pendingHide = this.hideTimers.get(documentUri);

        if (pendingHide) {
            clearTimeout(pendingHide);
            this.hideTimers.delete(documentUri);
        }
    }

    /**
     * Holds the lenses open across a conversion, which the user drives from a
     * lens and which takes long enough for a pending hide to fire mid-way.
     */
    keepHoverStateActive(documentUri: string): void {
        this.clearPendingHide(documentUri);

        this.isHoveringImport.set(documentUri, true);

        this._onDidChangeCodeLenses.fire();
    }

    /**
     * The conversion lenses for a document, and a "for all" lens beside each
     * where the file holds more than one import of that direction.
     *
     * An import gets a lens only where the conversion has somewhere to go: a
     * built-in module has no relative form, and a statement no module name can
     * be read out of has nothing to convert. So a file of nothing but Epic
     * imports carries no lens at all, and neither does one where the feature is
     * off or, in "hover" mode, nothing is hovered.
     */
    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];

        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const showCodeLens = config.get<boolean>("pathConversion.enableCodeLens", true);

        if (!showCodeLens) {
            return codeLenses;
        }

        const visibilityMode = this.getVisibilityMode();
        const documentUri = document.uri.toString();

        if (visibilityMode === "hover") {
            const isHovering = this.isHoveringImport.get(documentUri);
            if (!isHovering) {
                return codeLenses;
            }
        }

        const text = document.getText();
        const lines = text.split(LINE_SPLIT);

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

            if (this.importPathConverter.isFullPathImport(trimmedLine)) {
                if (!this.importPathConverter.isBuiltinModule(trimmedLine)) {
                    const moduleName = this.importPathConverter.extractModuleName(trimmedLine);

                    if (moduleName) {
                        const convertToRelativeLens = new vscode.CodeLens(range, {
                            title: `$(arrow-both)  Use relative path`,
                            tooltip: `Use relative path for '${moduleName}'`,
                            command: "verseAutoImports.convertToRelativePath",
                            arguments: [document, trimmedLine, i],
                        });
                        codeLenses.push(convertToRelativeLens);

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
                const moduleName = this.importPathConverter.extractModuleName(trimmedLine);

                if (moduleName) {
                    const convertSingleLens = new vscode.CodeLens(range, {
                        title: `$(arrow-both)  Use absolute path`,
                        tooltip: `Use absolute path for '${moduleName}'`,
                        command: "verseAutoImports.convertToFullPath",
                        arguments: [document, trimmedLine, i],
                    });
                    codeLenses.push(convertSingleLens);

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

    /** The lens unchanged: provideCodeLenses gives every lens its command, so none is resolved lazily. */
    resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
        return codeLens;
    }

    /** Asks VS Code to re-query the lenses. */
    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Re-queries the lenses of a document a conversion has just edited, and
     * asserts the hover state first so the lenses survive the edit that the
     * pointer, still over the import, would otherwise have to re-establish.
     */
    forceRefreshAfterConversion(documentUri: string): void {
        this.isHoveringImport.set(documentUri, true);

        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Releases the listeners, the event emitter and every pending timer. The
     * hide timers matter most: the delay is user-configurable up to 10000 ms,
     * so one armed just before teardown would otherwise fire seconds later and
     * push an event into a disposed emitter.
     */
    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;

        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
            this.refreshTimeout = null;
        }

        for (const timeout of this.hideTimers.values()) {
            clearTimeout(timeout);
        }
        this.hideTimers.clear();
        this.isHoveringImport.clear();

        this._onDidChangeCodeLenses.dispose();
    }
}

import * as vscode from "vscode";
import * as path from "path";
import { logger } from "../utils";
import { ImportSuggestion } from "../types";
import { ImportHandler } from "../imports";

/**
 * Turns the Verse compiler's diagnostics into imports: one debounce timer per
 * document, and on expiry, the suggestions it may act on without asking
 * written into it. A lone suggestion has to be high confidence; one picked out
 * of several by an auto_ strategy does not.
 *
 * Disposable, and registered as one during activation: the delay is
 * user-configurable, so an armed timer outlives teardown by that long unless it
 * is cancelled.
 */
export class DiagnosticsHandler {
    private importHandler: ImportHandler;
    private processingDocuments: Set<string> = new Set();
    private pendingTimers: Map<string, NodeJS.Timeout> = new Map();
    private delayMs: number = 1000;
    private disposed = false;

    constructor(
        private outputChannel: vscode.OutputChannel,
        importHandler: ImportHandler,
        // Consulted when a debounce timer fires, not when it is scheduled, so
        // a snooze started while a timer is already pending still suppresses
        // that import. Returns false when nothing is suppressing auto-import.
        // Required rather than defaulted: a call site that forgot it would
        // lose suppression silently at runtime instead of failing the build.
        private isAutoImportSuppressed: () => boolean,
    ) {
        // Injected rather than constructed so the auto-import path resolves
        // through the same handler as quick fixes; one built here would carry
        // neither the extension context nor the assets digest parser.
        this.importHandler = importHandler;
        logger.debug("DiagnosticsHandler", `Initialized with ${this.delayMs}ms delay`);
    }

    /**
     * Whether a diagnostics URI is a Verse file the extension may edit, asked
     * before any document is opened.
     *
     * A diagnostics event also carries VS Code's internal documents - private:
     * replace-preview buffers, git: views - which throw on openTextDocument,
     * and Epic's generated *.digest.verse files, which hold permanent LSP
     * errors and must never be edited.
     */
    static shouldProcessUri(uri: { scheme: string; fsPath: string }): boolean {
        if (uri.scheme !== "file") {
            return false;
        }
        const fsPath = uri.fsPath.toLowerCase();
        return fsPath.endsWith(".verse") && !fsPath.endsWith(".digest.verse");
    }

    /**
     * Whether a diagnostics URI is inside the configured auto-import scope. The
     * Verse LSP publishes diagnostics for the whole project, not only for what
     * is on screen, so without this the extension edits any .verse file the
     * compiler complains about.
     *
     * Call this before opening the document. Opening one is itself the
     * behaviour "openFiles" exists to prevent, since it pulls a file the user
     * never opened into the workspace.
     *
     * An unrecognized scope falls back to "allFiles", so a mistyped setting
     * degrades to the unrestricted scope rather than disabling auto-import
     * altogether.
     *
     * @param visibility `openUris` must come from the open tabs, never from
     *   vscode.workspace.textDocuments: that list holds every document opened
     *   programmatically by anything, and this extension's own
     *   ProjectPathScanner opens every .verse file in the project to build the
     *   path cache, so keyed on it "openFiles" admits the whole project. Both
     *   fields hold URI strings, as the rest of the extension keys
     *   per-document state - never fsPath, since two URIs can share a path and
     *   differ in scheme or query.
     */
    static isUriInScope(uri: { toString(): string }, scope: string, visibility: { openUris: readonly string[]; activeUri?: string }): boolean {
        if (!DiagnosticsHandler.scopeRestrictsDocuments(scope)) {
            return true;
        }
        const target = uri.toString();
        if (scope === "activeFile") {
            return visibility.activeUri === target;
        }
        // The active document counts as open even when no text tab reports it,
        // which keeps activeFile a strict subset of openFiles. A .verse file
        // focused in a diff editor is the case that needs it: it has an active
        // editor, but its tab is a TabInputTextDiff and so never reaches
        // openUris. Without this, tightening the setting one level would let
        // through an edit the looser level blocked.
        return visibility.activeUri === target || visibility.openUris.includes(target);
    }

    /**
     * Whether a scope narrows anything at all, which is what lets a caller skip
     * building a visibility snapshot it will not read.
     *
     * The single definition of that question on purpose: expressing it again at
     * the call site, in the opposite polarity, leaves the cheap path correct
     * only for as long as the two stay exact complements.
     */
    static scopeRestrictsDocuments(scope: string): boolean {
        return scope === "openFiles" || scope === "activeFile";
    }

    /**
     * Arms the debounce timer for a document, cancelling the one it already
     * has, and does nothing while that document is already being processed. The
     * import happens when the timer expires, long after this returns.
     */
    async handle(document: vscode.TextDocument) {
        // The diagnostics listener awaits openTextDocument before calling in,
        // so a continuation can resume after teardown. Arming a timer here
        // would put back exactly what dispose() just cancelled.
        if (this.disposed) {
            return;
        }

        // Key the debounce state by the full URI, never by the basename: UEFN
        // projects routinely hold same-named files in different module folders
        // (Weapons/utils.verse and UI/utils.verse), and a shared key makes one
        // file's diagnostics cancel or block the other's timer, silently
        // dropping an auto-import. The basename stays as the log label only.
        const documentKey = document.uri.toString();
        const displayName = path.basename(document.uri.fsPath);

        logger.trace("DiagnosticsHandler", `Received diagnostics for ${displayName}`);

        const existingTimer = this.pendingTimers.get(documentKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.pendingTimers.delete(documentKey);
            logger.trace("DiagnosticsHandler", `Cancelled pending timer for ${displayName} (debouncing)`);
        }

        if (this.processingDocuments.has(documentKey)) {
            logger.debug("DiagnosticsHandler", `Already processing ${displayName}, skipping new timer`);
            return;
        }

        logger.debug("DiagnosticsHandler", `Starting debounce timer (${this.delayMs}ms) for ${displayName}`);

        const timer = setTimeout(async () => {
            this.pendingTimers.delete(documentKey);
            this.processingDocuments.add(documentKey);
            try {
                const currentDiagnostics = vscode.languages.getDiagnostics(document.uri);

                logger.debug("DiagnosticsHandler", `Processing diagnostics for ${displayName} after delay`);

                const config = vscode.workspace.getConfiguration("verseAutoImports");
                const autoImportEnabled = config.get<boolean>("general.autoImport", true) && !this.isAutoImportSuppressed();
                const multiOptionStrategy = config.get<string>("behavior.multiOptionStrategy", "quickfix");

                const autoImportSuggestions = new Set<string>();
                // The line a diagnostic was reported on, kept beside the
                // statement it asked for. Placement needs it to tell a pinned
                // import that failed to resolve from one that merely looks as
                // though it could (ImportDocumentEditor.couldResolveAgainst),
                // and this loop is the last place it exists.
                //
                // Both go through one function so the set and the map cannot
                // disagree about which statements were added: a statement in
                // the set with no line placed as though no diagnostic asked for
                // it, which is the reading this signal exists to correct.
                const diagnosticLinesByStatement = new Map<string, number[]>();
                const recordSuggestion = (statement: string, diagnostic: vscode.Diagnostic): void => {
                    autoImportSuggestions.add(statement);
                    diagnosticLinesByStatement.set(statement, [...(diagnosticLinesByStatement.get(statement) ?? []), diagnostic.range.start.line]);
                };
                let hasMultiOptionSuggestions = false;

                for (const diagnostic of currentDiagnostics) {
                    const suggestions = await this.importHandler.extractImportSuggestions(diagnostic.message);

                    if (suggestions.length === 0) {
                        continue;
                    }

                    if (suggestions.length > 1) {
                        hasMultiOptionSuggestions = true;
                        logger.debug("DiagnosticsHandler", `Multi-option diagnostic found with ${suggestions.length} suggestions - will use quick fixes`);

                        if (multiOptionStrategy.startsWith("auto_")) {
                            const selectedSuggestion = this.selectBestSuggestion(suggestions, multiOptionStrategy);
                            if (selectedSuggestion && autoImportEnabled) {
                                recordSuggestion(selectedSuggestion.importStatement, diagnostic);
                                logger.debug("DiagnosticsHandler", `Auto-selected: ${selectedSuggestion.importStatement}`);
                            }
                        }
                        // Under the quickfix strategy nothing is imported here:
                        // ImportCodeActionProvider offers the options instead.
                        continue;
                    }

                    const suggestion = suggestions[0];
                    if (autoImportEnabled && suggestion.confidence === "high") {
                        logger.debug("DiagnosticsHandler", `Adding high-confidence import: ${suggestion.importStatement}`);
                        recordSuggestion(suggestion.importStatement, diagnostic);
                    } else {
                        logger.debug("DiagnosticsHandler", `Low confidence or auto-import disabled - will use quick fix for: ${suggestion.importStatement}`);
                    }
                }

                // Teardown can land between the timer firing and here, because
                // extracting suggestions is awaited. clearTimeout in dispose()
                // cannot cancel a callback that has already started, so the
                // edit is the point that has to re-check.
                if (this.disposed) {
                    logger.debug("DiagnosticsHandler", `Discarding diagnostics for ${displayName}: handler disposed`);
                    return;
                }

                if (autoImportSuggestions.size > 0) {
                    logger.info("DiagnosticsHandler", `Auto-importing ${autoImportSuggestions.size} statements`);
                    autoImportSuggestions.forEach((imp) => {
                        logger.debug("DiagnosticsHandler", `Will auto-import: ${imp}`);
                    });

                    // The edit is rejected when the document moved on between
                    // the read and the write, or when the file is read-only.
                    // Reporting the imports as applied hides that entirely.
                    const applied = await this.importHandler.addImportsToDocument(document, Array.from(autoImportSuggestions), diagnosticLinesByStatement);

                    if (applied) {
                        vscode.window.setStatusBarMessage(`Auto-imported ${autoImportSuggestions.size} statements to ${displayName}`, 3000);
                    } else {
                        logger.warn("DiagnosticsHandler", `Failed to auto-import ${autoImportSuggestions.size} statements to ${displayName}`);
                        vscode.window.showWarningMessage(`Could not auto-import ${autoImportSuggestions.size} statement(s) into ${displayName}. The document may have changed or be read-only.`);
                    }
                }

                if (hasMultiOptionSuggestions && multiOptionStrategy === "quickfix") {
                    vscode.window.setStatusBarMessage(`Multiple import options available - use quick fixes (Ctrl+.)`, 5000);
                }
            } catch (error) {
                logger.error("DiagnosticsHandler", "Error processing diagnostics", error);
            } finally {
                this.processingDocuments.delete(documentKey);
                logger.trace("DiagnosticsHandler", `Finished processing ${displayName}`);
            }
        }, this.delayMs);

        this.pendingTimers.set(documentKey, timer);
    }

    /**
     * Picks the one suggestion to import from several. An unrecognized strategy
     * takes the first, so a mistyped setting still imports something rather
     * than nothing.
     */
    private selectBestSuggestion(suggestions: ImportSuggestion[], strategy: string): ImportSuggestion | null {
        if (suggestions.length === 0) {
            return null;
        }

        switch (strategy) {
            case "auto_shortest":
                return suggestions.reduce((shortest, current) => (current.importStatement.length < shortest.importStatement.length ? current : shortest));
            case "auto_first":
                return suggestions[0];
            default:
                return suggestions[0];
        }
    }

    /**
     * Sets the debounce delay for timers armed from now on. A timer already
     * pending keeps the delay it was armed with.
     */
    setDelay(delayMs: number) {
        this.delayMs = delayMs;
        logger.info("DiagnosticsHandler", `Diagnostic processing delay set to ${delayMs}ms`);
    }

    /**
     * Cancels every armed debounce timer so none can fire after deactivation,
     * and refuses any further work.
     *
     * The delay is user-configurable, so a timer armed by the last keystroke
     * before a reload would otherwise apply an edit to a document belonging to
     * a torn-down extension. A callback that has already started cannot be
     * cancelled, which is why `disposed` is re-checked before the edit.
     */
    dispose(): void {
        this.disposed = true;
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
        logger.debug("DiagnosticsHandler", "Disposed: pending debounce timers cancelled");
    }
}

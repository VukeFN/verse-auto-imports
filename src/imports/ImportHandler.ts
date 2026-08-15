import * as vscode from "vscode";
import { DiagnosticLinesByPath, DiagnosticLinesByStatement, ImportSuggestion, MissingImports } from "../types";
import { AssetsDigestParser } from "../services";
import { ImportFormatter } from "./ImportFormatter";
import { ImportSuggestionExtractor } from "./ImportSuggestionExtractor";
import { ImportDocumentEditor } from "./ImportDocumentEditor";

/**
 * The way in to import handling: suggestion extraction, document editing and
 * formatting behind one object.
 *
 * Go through this rather than around it. It is the only place the extension
 * context and the assets digest parser are threaded into
 * ImportSuggestionExtractor, so an extractor built directly gets whichever of
 * the two the caller remembered to pass.
 */
export class ImportHandler {
    private formatter: ImportFormatter;
    private suggestionExtractor: ImportSuggestionExtractor;
    private documentEditor: ImportDocumentEditor;

    constructor(
        private outputChannel: vscode.OutputChannel,
        assetsDigestParser?: AssetsDigestParser,
        extensionContext?: vscode.ExtensionContext,
    ) {
        this.formatter = new ImportFormatter();
        this.suggestionExtractor = new ImportSuggestionExtractor(outputChannel, this.formatter, assetsDigestParser, extensionContext);
        this.documentEditor = new ImportDocumentEditor(outputChannel, this.formatter);
    }

    /**
     * @param resource The document the message was reported on. Pass it
     *   wherever one exists: the suggestion carries the formatted statement,
     *   and `behavior.importSyntax` is resource-scoped, so without it a
     *   suggestion can be written in the window's syntax while
     *   addImportsToDocument inserts the folder's.
     */
    async extractImportSuggestions(errorMessage: string, resource?: vscode.Uri): Promise<ImportSuggestion[]> {
        return this.suggestionExtractor.extractImportSuggestions(errorMessage, resource);
    }

    async addImportsToDocument(document: vscode.TextDocument, importStatements: string[], diagnosticLinesByStatement?: DiagnosticLinesByStatement): Promise<boolean> {
        return this.documentEditor.addImportsToDocument(document, importStatements, diagnosticLinesByStatement);
    }

    /**
     * Rebuilds the document's import block in one atomic edit: existing
     * imports plus the given additional paths, deduplicated, grouped,
     * sorted, and formatted per settings.
     *
     * @param diagnosticLinesByPath Pass whatever produced `additionalPaths`
     *   reported, where it came from diagnostics. Without it a pinned import
     *   the compiler is reporting on cannot be told from one that already
     *   resolves, and an added path can land below the statement it was added
     *   for.
     */
    async organizeImports(document: vscode.TextDocument, additionalPaths: string[], diagnosticLinesByPath?: DiagnosticLinesByPath): Promise<boolean> {
        return this.documentEditor.organizeImports(document, additionalPaths, diagnosticLinesByPath);
    }

    extractImportsFromDiagnostics(diagnostics: vscode.Diagnostic[]): MissingImports {
        return this.suggestionExtractor.extractImportsFromDiagnostics(diagnostics);
    }

    /**
     * The edits that would give the file the configured number of empty lines
     * after its import block, without applying them. For the save participant,
     * which hands them to VS Code so they land as part of the save.
     *
     * There is no applying counterpart on the facade: the only callers that
     * apply the spacing themselves are inside ImportDocumentEditor, at the end
     * of adding and organizing imports.
     */
    computeEmptyLinesAfterImportsEdits(document: vscode.TextDocument): vscode.TextEdit[] {
        return this.documentEditor.computeEmptyLinesAfterImportsEdits(document);
    }
}

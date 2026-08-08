import * as vscode from "vscode";
import { ImportSuggestion } from "../types";
import { AssetsDigestParser } from "../services";
import { ImportFormatter } from "./ImportFormatter";
import { ImportSuggestionExtractor } from "./ImportSuggestionExtractor";
import { ImportDocumentEditor } from "./ImportDocumentEditor";

/**
 * Facade class that coordinates import handling operations.
 * Maintains backward compatibility while delegating to specialized classes.
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
     * Extracts existing import statements from a document.
     */
    extractExistingImports(document: vscode.TextDocument): string[] {
        return this.documentEditor.extractExistingImports(document);
    }

    /**
     * Extracts import suggestions from an error message.
     */
    async extractImportSuggestions(errorMessage: string): Promise<ImportSuggestion[]> {
        return this.suggestionExtractor.extractImportSuggestions(errorMessage);
    }

    /**
     * Adds import statements to a document.
     */
    async addImportsToDocument(document: vscode.TextDocument, importStatements: string[]): Promise<boolean> {
        return this.documentEditor.addImportsToDocument(document, importStatements);
    }

    /**
     * Rebuilds the document's import block in one atomic edit: existing
     * imports plus the given additional paths, deduplicated, grouped,
     * sorted, and formatted per settings.
     */
    async organizeImports(document: vscode.TextDocument, additionalPaths: string[]): Promise<boolean> {
        return this.documentEditor.organizeImports(document, additionalPaths);
    }

    /**
     * Extracts import suggestions from VS Code diagnostics.
     */
    extractImportsFromDiagnostics(diagnostics: vscode.Diagnostic[]): string[] {
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

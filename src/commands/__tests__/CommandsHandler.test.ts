import * as vscode from "vscode";
import { CommandsHandler, CommandsDependencies } from "../CommandsHandler";
import { ImportHandler } from "../../imports";

// Regression for #133: addImportsToDocument and organizeImports return false
// when applyEdit is rejected - a stale document version, or a read-only file -
// and both call sites discarded the boolean. The user was shown a success
// message for a document that never changed, and optimizeImports went on to
// save it.

const IMPORT_STATEMENT = "using { /Fortnite.com/Devices }";

function makeDocument(): vscode.TextDocument & { save: jest.Mock } {
    return {
        uri: vscode.Uri.file("C:\\Project\\Content\\device.verse"),
        languageId: "verse",
        save: jest.fn().mockResolvedValue(true),
    } as unknown as vscode.TextDocument & { save: jest.Mock };
}

/** activeTextEditor is a read-only binding through a namespace import. */
function setActiveEditor(editor: vscode.TextEditor | undefined): void {
    (vscode.window as { activeTextEditor: vscode.TextEditor | undefined }).activeTextEditor = editor;
}

function makeHandler(importHandlerOverrides: Partial<ImportHandler>): CommandsHandler {
    const importHandler = {
        addImportsToDocument: jest.fn().mockResolvedValue(true),
        organizeImports: jest.fn().mockResolvedValue(true),
        extractImportsFromDiagnostics: jest.fn().mockReturnValue([]),
        ...importHandlerOverrides,
    } as unknown as ImportHandler;

    return new CommandsHandler({ importHandler } as unknown as CommandsDependencies);
}

beforeEach(() => {
    jest.clearAllMocks();
});

afterEach(() => {
    setActiveEditor(undefined);
});

describe("CommandsHandler.addSingleImport", () => {
    it("warns and reports no success when the edit is rejected", async () => {
        const handler = makeHandler({ addImportsToDocument: jest.fn().mockResolvedValue(false) });

        await handler.addSingleImport(makeDocument(), IMPORT_STATEMENT);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not add import/);
        expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    });

    it("reports success when the edit applies", async () => {
        const handler = makeHandler({ addImportsToDocument: jest.fn().mockResolvedValue(true) });

        await handler.addSingleImport(makeDocument(), IMPORT_STATEMENT);

        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.setStatusBarMessage as jest.Mock).mock.calls[0][0]).toBe(`Added import: ${IMPORT_STATEMENT}`);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

describe("CommandsHandler.optimizeImports", () => {
    function activateVerseDocument(): vscode.TextDocument & { save: jest.Mock } {
        const document = makeDocument();
        setActiveEditor({ document } as unknown as vscode.TextEditor);
        return document;
    }

    it("warns, does not save, and reports no success when the edit is rejected", async () => {
        const document = activateVerseDocument();
        const handler = makeHandler({ organizeImports: jest.fn().mockResolvedValue(false) });

        await handler.optimizeImports();

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not optimize imports/);
        // Saving here would write the unorganized content back to disk.
        expect(document.save).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("saves and reports success when the edit applies", async () => {
        const document = activateVerseDocument();
        const handler = makeHandler({ organizeImports: jest.fn().mockResolvedValue(true) });

        await handler.optimizeImports();

        expect(document.save).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Imports optimized successfully");
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

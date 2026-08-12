import * as vscode from "vscode";
import { CommandsHandler, CommandsDependencies } from "../CommandsHandler";
import { ImportHandler, ImportPathConverter, ImportCodeLensProvider } from "../../imports";

// Regression for #133: addImportsToDocument and organizeImports return false
// when applyEdit is rejected - a stale document version, or a read-only file -
// and both call sites discarded the boolean. The user was shown a success
// message for a document that never changed, and optimizeImports went on to
// save it.

const IMPORT_STATEMENT = "using { /Fortnite.com/Devices }";

function makeDocument(fsPath = "C:\\Project\\Content\\device.verse"): vscode.TextDocument & { save: jest.Mock } {
    return {
        uri: vscode.Uri.file(fsPath),
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

/** Every command registerAll registers, with the method it binds, in the order its groups are spread. */
const REGISTERED_COMMANDS: Array<[string, string]> = [
    ["verseAutoImports.addSingleImport", "addSingleImport"],
    ["verseAutoImports.optimizeImports", "optimizeImports"],
    ["verseAutoImports.showStatusMenu", "showStatusMenu"],
    ["verseAutoImports.toggleAutoImport", "toggleAutoImport"],
    ["verseAutoImports.togglePreserveLocations", "togglePreserveLocations"],
    ["verseAutoImports.toggleImportSyntax", "toggleImportSyntax"],
    ["verseAutoImports.toggleDigestFiles", "toggleDigestFiles"],
    ["verseAutoImports.toggleFullPathCodeLens", "toggleFullPathCodeLens"],
    ["verseAutoImports.snoozeAutoImport", "snoozeAutoImport"],
    ["verseAutoImports.cancelSnooze", "cancelSnooze"],
    ["verseAutoImports.exportDebugLogs", "exportDebugLogs"],
    ["verseAutoImports.captureDiagnosticsCorpus", "captureDiagnosticsCorpus"],
    ["verseAutoImports.rebuildPathCache", "rebuildPathCache"],
    ["verseAutoImports.clearPathCache", "clearPathCache"],
    ["verseAutoImports.showCacheStatus", "showCacheStatus"],
    ["verseAutoImports.convertToFullPath", "convertToFullPath"],
    ["verseAutoImports.convertAllToFullPath", "convertAllToFullPath"],
    ["verseAutoImports.convertToRelativePath", "convertToRelativePath"],
    ["verseAutoImports.convertAllToRelativePath", "convertAllToRelativePath"],
    ["verseAutoImports.makeModulePublic", "makeModulePublic"],
];

function registeredCommands(): Array<[string, string]> {
    return (vscode.commands.registerCommand as jest.Mock).mock.calls.map(([commandId, handler]) => [commandId, handler.name]);
}

// The integration suite asserts the same ids are registered, but only with an
// extension host running - so nothing in this suite would catch a command lost
// from one of registerAll's group tables, or bound to the wrong method.
describe("CommandsHandler.registerAll", () => {
    it("registers every command id once, in group order", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        makeHandler({}).registerAll(context);

        expect(registeredCommands().map(([commandId]) => commandId)).toEqual(REGISTERED_COMMANDS.map(([commandId]) => commandId));
    });

    it("binds each id to its own method", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        makeHandler({}).registerAll(context);

        // bind() names its result "bound <method>", which is the only trace of
        // the original method left on a registered handler.
        expect(registeredCommands()).toEqual(REGISTERED_COMMANDS.map(([commandId, method]) => [commandId, `bound ${method}`]));
    });

    it("hands every registration to the context for disposal", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        makeHandler({}).registerAll(context);

        expect(context.subscriptions).toHaveLength(REGISTERED_COMMANDS.length);
    });
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

// Regression for #185: the same class as #133, for the four path conversion
// commands. applyConversion returns false when it cannot find the line to
// rewrite, when applyEdit is rejected, or when the edit throws; the single
// conversions discarded the boolean and reported the new path anyway, and the
// bulk conversions only counted it, so a run where every edit was refused
// reported "Using absolute paths for 0 imports".

const RELATIVE_MODULE = "Gadgets/Tools";
const ABSOLUTE_PATH = `/mygame@fortnite.com/mygame/${RELATIVE_MODULE}`;

/**
 * The shape CommandsHandler reads off a conversion. Declared here because both
 * PathConversionResult and ImportConversionResult are module-private, and an
 * untyped fixture lets a mistyped key through to an assertion that still passes.
 */
interface ConversionFixture {
    originalImport: string;
    fullPathImport: string;
    moduleName: string;
    isAmbiguous: boolean;
    possiblePaths?: string[];
}

function makeConversion(overrides: Partial<ConversionFixture> = {}): ConversionFixture {
    return {
        originalImport: `using { ${RELATIVE_MODULE} }`,
        fullPathImport: `using { ${ABSOLUTE_PATH} }`,
        moduleName: RELATIVE_MODULE,
        isAmbiguous: false,
        ...overrides,
    };
}

function makeConversionHandler(converterOverrides: Record<string, jest.Mock>): {
    handler: CommandsHandler;
    codeLensProvider: { keepHoverStateActive: jest.Mock; forceRefreshAfterConversion: jest.Mock };
} {
    const importPathConverter = {
        convertToFullPath: jest.fn().mockResolvedValue(null),
        convertFromFullPath: jest.fn().mockResolvedValue(null),
        convertAllImportsInDocument: jest.fn().mockResolvedValue([]),
        convertAllImportsFromFullPath: jest.fn().mockResolvedValue([]),
        applyConversion: jest.fn().mockResolvedValue(true),
        ...converterOverrides,
    } as unknown as ImportPathConverter;

    const codeLensProvider = {
        keepHoverStateActive: jest.fn(),
        forceRefreshAfterConversion: jest.fn(),
    };

    const handler = new CommandsHandler({
        importPathConverter,
        importCodeLensProvider: codeLensProvider as unknown as ImportCodeLensProvider,
    } as unknown as CommandsDependencies);

    return { handler, codeLensProvider };
}

// clearAllMocks clears calls but not implementations, so a quick pick stubbed in
// one test would otherwise survive into every test declared after it.
afterEach(() => {
    (vscode.window.showQuickPick as jest.Mock).mockReset();
});

describe("CommandsHandler.convertToFullPath", () => {
    it("warns and reports no path when the edit is refused", async () => {
        const { handler, codeLensProvider } = makeConversionHandler({
            convertToFullPath: jest.fn().mockResolvedValue(makeConversion()),
            applyConversion: jest.fn().mockResolvedValue(false),
        });

        await handler.convertToFullPath(makeDocument(), `using { ${RELATIVE_MODULE} }`, 4);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not convert import/);
        expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
        // The document is unchanged, so the lenses on it are still accurate.
        expect(codeLensProvider.forceRefreshAfterConversion).not.toHaveBeenCalled();
    });

    it("reports the new path when the edit applies", async () => {
        const { handler, codeLensProvider } = makeConversionHandler({
            convertToFullPath: jest.fn().mockResolvedValue(makeConversion()),
            applyConversion: jest.fn().mockResolvedValue(true),
        });

        await handler.convertToFullPath(makeDocument(), `using { ${RELATIVE_MODULE} }`, 4);

        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.setStatusBarMessage as jest.Mock).mock.calls[0][0]).toBe(`Using absolute path: using { ${ABSOLUTE_PATH} }`);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(codeLensProvider.forceRefreshAfterConversion).toHaveBeenCalledTimes(1);
    });

    it("warns when the edit is refused after an ambiguous path was picked", async () => {
        (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: Array<{ path: string }>) => items[0]);
        const { handler } = makeConversionHandler({
            convertToFullPath: jest.fn().mockResolvedValue(makeConversion({ isAmbiguous: true, possiblePaths: [ABSOLUTE_PATH] })),
            applyConversion: jest.fn().mockResolvedValue(false),
        });

        await handler.convertToFullPath(makeDocument(), `using { ${RELATIVE_MODULE} }`, 4);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not convert import/);
        expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    });
});

describe("CommandsHandler.convertToRelativePath", () => {
    it("warns and reports no path when the edit is refused", async () => {
        const { handler } = makeConversionHandler({
            convertFromFullPath: jest.fn().mockResolvedValue(makeConversion({ fullPathImport: `using { ${RELATIVE_MODULE} }` })),
            applyConversion: jest.fn().mockResolvedValue(false),
        });

        await handler.convertToRelativePath(makeDocument(), `using { ${ABSOLUTE_PATH} }`, 4);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not convert import/);
        expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    });
});

describe("CommandsHandler.convertAllToFullPath", () => {
    it("warns rather than reporting a count when every edit is refused", async () => {
        const { handler } = makeConversionHandler({
            convertAllImportsInDocument: jest.fn().mockResolvedValue([makeConversion(), makeConversion()]),
            applyConversion: jest.fn().mockResolvedValue(false),
        });

        await handler.convertAllToFullPath(makeDocument());

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/2 could not be converted/);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("counts a cancelled ambiguous pick as neither converted nor failed", async () => {
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
        const { handler } = makeConversionHandler({
            convertAllImportsInDocument: jest.fn().mockResolvedValue([makeConversion({ isAmbiguous: true, possiblePaths: [ABSOLUTE_PATH] })]),
            applyConversion: jest.fn().mockResolvedValue(true),
        });

        await handler.convertAllToFullPath(makeDocument());

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Using absolute paths for 0 imports.");
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

describe("CommandsHandler.convertAllToRelativePath", () => {
    it("names the failures alongside the count when only some edits are refused", async () => {
        const { handler } = makeConversionHandler({
            convertAllImportsFromFullPath: jest.fn().mockResolvedValue([makeConversion(), makeConversion()]),
            applyConversion: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        });

        await handler.convertAllToRelativePath(makeDocument());

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Using relative paths for 1 import\. 1 could not be converted/);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("reports the count as before when every edit applies", async () => {
        const { handler } = makeConversionHandler({
            convertAllImportsFromFullPath: jest.fn().mockResolvedValue([makeConversion(), makeConversion()]),
            applyConversion: jest.fn().mockResolvedValue(true),
        });

        await handler.convertAllToRelativePath(makeDocument());

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Using relative paths for 2 imports.");
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

/**
 * A conversion command, the converter result that carries it through to a
 * finalized conversion, and how to invoke it. The overrides are built per case
 * rather than shared, so one case's call counts cannot leak into another's.
 */
type ConversionCommandCase = [name: string, converterOverrides: () => Record<string, jest.Mock>, run: (handler: CommandsHandler, document: vscode.TextDocument) => Promise<void>];

const CONVERSION_COMMANDS: ConversionCommandCase[] = [
    ["convertToFullPath", () => ({ convertToFullPath: jest.fn().mockResolvedValue(makeConversion()) }), (handler, document) => handler.convertToFullPath(document, `using { ${RELATIVE_MODULE} }`, 4)],
    [
        "convertToRelativePath",
        () => ({ convertFromFullPath: jest.fn().mockResolvedValue(makeConversion()) }),
        (handler, document) => handler.convertToRelativePath(document, `using { ${ABSOLUTE_PATH} }`, 4),
    ],
    ["convertAllToFullPath", () => ({ convertAllImportsInDocument: jest.fn().mockResolvedValue([makeConversion()]) }), (handler, document) => handler.convertAllToFullPath(document)],
    ["convertAllToRelativePath", () => ({ convertAllImportsFromFullPath: jest.fn().mockResolvedValue([makeConversion()]) }), (handler, document) => handler.convertAllToRelativePath(document)],
];

// The provider keys its hover state on the string these commands hand it, so
// the commands are half of that keying. One that forwarded a basename, or a
// stale document's uri, would collide two same-named files without the provider
// changing at all.
describe("CommandsHandler per-document conversion keying", () => {
    const WEAPONS_UTILS = "C:\\Project\\Content\\Weapons\\utils.verse";
    const UI_UTILS = "C:\\Project\\Content\\UI\\utils.verse";

    it.each(CONVERSION_COMMANDS)("%s forwards the acting document's own uri", async (_name, converterOverrides, run) => {
        const { handler, codeLensProvider } = makeConversionHandler(converterOverrides());
        const document = makeDocument(WEAPONS_UTILS);

        await run(handler, document);

        expect(codeLensProvider.keepHoverStateActive).toHaveBeenCalledWith(document.uri.toString());
        expect(codeLensProvider.forceRefreshAfterConversion).toHaveBeenCalledWith(document.uri.toString());
    });

    // The converter places the importing scope from this uri, so it decides
    // which module the path is shortened against. A stale or substituted
    // document changes the spelling written, and nothing else would show it.
    it("hands the acting document's uri to convertFromFullPath", async () => {
        const convertFromFullPath = jest.fn().mockResolvedValue(makeConversion());
        const { handler } = makeConversionHandler({ convertFromFullPath });
        const document = makeDocument(WEAPONS_UTILS);

        await handler.convertToRelativePath(document, `using { ${ABSOLUTE_PATH} }`, 4);

        expect(convertFromFullPath).toHaveBeenCalledWith(`using { ${ABSOLUTE_PATH} }`, document.uri, 4);
    });

    it.each(CONVERSION_COMMANDS)("%s forwards a distinct uri for each of two same-named documents", async (_name, converterOverrides, run) => {
        const { handler, codeLensProvider } = makeConversionHandler(converterOverrides());
        const weapons = makeDocument(WEAPONS_UTILS);
        const ui = makeDocument(UI_UTILS);

        await run(handler, weapons);
        await run(handler, ui);

        for (const forwarding of [codeLensProvider.keepHoverStateActive, codeLensProvider.forceRefreshAfterConversion]) {
            const forwarded = forwarding.mock.calls.map(([documentUri]) => documentUri);
            expect(forwarded).toEqual([weapons.uri.toString(), ui.uri.toString()]);
            // Both sides of that comparison run through the same toString(), so
            // it would still hold if the key itself collapsed onto one value.
            // This is the half that fails when it does.
            expect(new Set(forwarded).size).toBe(2);
        }
    });
});

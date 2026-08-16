import * as vscode from "vscode";
import { CommandsHandler, CommandsDependencies } from "../CommandsHandler";
import { logger } from "../../utils";
import { ImportHandler, ImportPathConverter, ImportCodeLensProvider } from "../../imports";
import { ProjectPathCache } from "../../services";
import { StatusBarHandler } from "../../ui";

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
        extractImportsFromDiagnostics: jest.fn().mockReturnValue({ paths: [], diagnosticPositionsByPath: new Map() }),
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
    ["verseAutoImports.organizeImportsInDocument", "organizeImportsInDocument"],
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

    // Regression for #385: the command adds what the compiler currently reports
    // as missing, so the positions it reported them at are evidence the
    // organizer needs to tell a pinned import that failed to resolve from one
    // that already resolves. Dropped here, the command writes the fix below the
    // statement that needed it and still reports success.
    //
    // Asserted through the delegating entry point as well as at
    // organizeImportsInDocument, since it is the delegation that carries the
    // evidence to the source action too.
    it("hands the organizer the positions the diagnostics were reported at", async () => {
        activateVerseDocument();
        const diagnosticPositionsByPath = new Map([["Features", [{ line: 4, character: 2 }]]]);
        const organizeImports = jest.fn().mockResolvedValue(true);
        const handler = makeHandler({
            organizeImports,
            extractImportsFromDiagnostics: jest.fn().mockReturnValue({ paths: ["Features"], diagnosticPositionsByPath }),
        });

        await handler.optimizeImports();

        expect(organizeImports).toHaveBeenCalledTimes(1);
        expect(organizeImports.mock.calls[0][1]).toEqual(["Features"]);
        expect(organizeImports.mock.calls[0][2]).toBe(diagnosticPositionsByPath);
    });
});

// Regression for #387: what the Organize Imports source action runs. It shares
// the organizing with optimizeImports and differs in what it deliberately does
// not do - editor.codeActionsOnSave runs it during a save, so a save of its own
// would re-enter that one.
describe("CommandsHandler.organizeImportsInDocument", () => {
    it("organizes the document it is given, with the paths the diagnostics report missing", async () => {
        const document = makeDocument();
        const organizeImports = jest.fn().mockResolvedValue(true);
        const diagnosticPositionsByPath = new Map([["/Fortnite.com/Devices", [{ line: 3, character: 0 }]]]);
        const handler = makeHandler({
            organizeImports,
            extractImportsFromDiagnostics: jest.fn().mockReturnValue({ paths: ["/Fortnite.com/Devices"], diagnosticPositionsByPath }),
        });

        const applied = await handler.organizeImportsInDocument(document);

        expect(applied).toBe(true);
        expect(organizeImports).toHaveBeenCalledWith(document, ["/Fortnite.com/Devices"], diagnosticPositionsByPath);
    });

    it("does not save, and does not fall back to the active editor", async () => {
        const active = makeDocument("C:\\Project\\Content\\other.verse");
        setActiveEditor({ document: active } as unknown as vscode.TextEditor);
        const document = makeDocument();
        const organizeImports = jest.fn().mockResolvedValue(true);
        const handler = makeHandler({ organizeImports });

        await handler.organizeImportsInDocument(document);

        expect(organizeImports).toHaveBeenCalledWith(document, [], new Map());
        expect(document.save).not.toHaveBeenCalled();
        expect(active.save).not.toHaveBeenCalled();
    });

    // VS Code discards what the command returns, so a bare false reaching it is
    // the silence #387 was filed about, arriving at the new entry point.
    it("warns the user when the edit does not apply", async () => {
        const handler = makeHandler({ organizeImports: jest.fn().mockResolvedValue(false) });

        await expect(handler.organizeImportsInDocument(makeDocument())).resolves.toBe(false);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not optimize imports/);
    });

    // codeActionsOnSave runs this as a save participant, and VS Code logs a
    // participant's failure where nobody looks rather than surfacing it.
    it("reports a throw rather than letting it escape into the save", async () => {
        const handler = makeHandler({ organizeImports: jest.fn().mockRejectedValue(new Error("boom")) });

        await expect(handler.organizeImportsInDocument(makeDocument())).resolves.toBe(false);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0]).toMatch(/Failed to optimize imports/);
    });

    it("says nothing when the organize succeeds", async () => {
        const handler = makeHandler({ organizeImports: jest.fn().mockResolvedValue(true) });

        await handler.organizeImportsInDocument(makeDocument());

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
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
    convertedImport: string;
    moduleName: string;
    isAmbiguous: boolean;
    possiblePaths?: string[];
}

function makeConversion(overrides: Partial<ConversionFixture> = {}): ConversionFixture {
    return {
        originalImport: `using { ${RELATIVE_MODULE} }`,
        convertedImport: `using { ${ABSOLUTE_PATH} }`,
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
        convertAllImportsToFullPath: jest.fn().mockResolvedValue([]),
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
            convertFromFullPath: jest.fn().mockResolvedValue(makeConversion({ convertedImport: `using { ${RELATIVE_MODULE} }` })),
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
            convertAllImportsToFullPath: jest.fn().mockResolvedValue([makeConversion(), makeConversion()]),
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
            convertAllImportsToFullPath: jest.fn().mockResolvedValue([makeConversion({ isAmbiguous: true, possiblePaths: [ABSOLUTE_PATH] })]),
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
    ["convertAllToFullPath", () => ({ convertAllImportsToFullPath: jest.fn().mockResolvedValue([makeConversion()]) }), (handler, document) => handler.convertAllToFullPath(document)],
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

// Regression for #363: a command that reports a failure only through
// showErrorMessage leaves the extension's own log empty, so the log export the
// maintainer asks for afterwards omits the failure being reported. Asserted at
// the command entry points rather than at the catch blocks, since a toggle
// reaches its write through toggleConfig and only the entry point proves the
// path a user takes is covered.
describe("CommandsHandler failure logging", () => {
    /** The default the suite-wide getConfiguration mock returns, restored after each override. */
    const WORKING_CONFIGURATION = {
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn().mockResolvedValue(undefined),
        // The write target is derived from inspect(), so a configuration stub
        // without it throws before the write is reached.
        inspect: jest.fn().mockReturnValue(undefined),
    };

    let errors: jest.SpyInstance;
    /** Spied only by the exportDebugLogs case, and restored here for all of them. */
    let exportedLogs: jest.SpyInstance | undefined;

    beforeEach(() => {
        errors = jest.spyOn(logger, "error").mockImplementation(() => {});
    });

    // Every restore belongs here rather than at the end of a test body: a
    // failing assertion skips the tail of the body, and clearAllMocks leaves a
    // mockReturnValue in place, so a rejecting configuration or a mocked logger
    // singleton would survive into every later test.
    afterEach(() => {
        errors.mockRestore();
        exportedLogs?.mockRestore();
        exportedLogs = undefined;
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(WORKING_CONFIGURATION);
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([]);
        (vscode.window.showInformationMessage as jest.Mock).mockReset();
    });

    /** Every palette toggle, each of which writes its setting through toggleConfig. */
    const TOGGLE_COMMANDS: Array<[string, (handler: CommandsHandler) => Promise<void>]> = [
        ["toggleAutoImport", (handler) => handler.toggleAutoImport()],
        ["togglePreserveLocations", (handler) => handler.togglePreserveLocations()],
        ["toggleImportSyntax", (handler) => handler.toggleImportSyntax()],
        ["toggleDigestFiles", (handler) => handler.toggleDigestFiles()],
        ["toggleFullPathCodeLens", (handler) => handler.toggleFullPathCodeLens()],
    ];

    describe("a rejected global settings write", () => {
        function rejectConfigurationWrites(): void {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(false),
                update: jest.fn().mockRejectedValue(new Error("EACCES: settings.json is read-only")),
                inspect: jest.fn().mockReturnValue(undefined),
            });
        }

        function makeToggleHandler(): CommandsHandler {
            return new CommandsHandler({
                statusBarHandler: { updateDisplay: jest.fn() } as unknown as StatusBarHandler,
            } as unknown as CommandsDependencies);
        }

        it.each(TOGGLE_COMMANDS)("%s logs the failure and tells the user, rather than throwing", async (_name, run) => {
            rejectConfigurationWrites();

            await expect(run(makeToggleHandler())).resolves.toBeUndefined();

            expect(errors).toHaveBeenCalledTimes(1);
            expect(errors.mock.calls[0][0]).toBe("CommandsHandler");
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
            expect((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0]).toMatch(/Action failed: EACCES/);
        });

        it("names the setting it could not write", async () => {
            rejectConfigurationWrites();

            await makeToggleHandler().toggleAutoImport();

            expect(errors.mock.calls[0][1]).toMatch(/general\.autoImport/);
        });
    });

    // logger.exportDebugLogs logs the write itself before rethrowing, so the
    // untraced half is what follows it: opening the file it wrote.
    it("exportDebugLogs logs a failure to open the exported file", async () => {
        const uri = vscode.Uri.file("C:\\Temp\\verseAutoImports_debugLogs.log");
        exportedLogs = jest.spyOn(logger, "exportDebugLogs").mockResolvedValue(uri);
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue("Open File");
        (vscode.commands.executeCommand as jest.Mock).mockRejectedValue(new Error("no editor for this file"));

        await new CommandsHandler({} as unknown as CommandsDependencies).exportDebugLogs();

        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors.mock.calls[0][0]).toBe("CommandsHandler");
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("captureDiagnosticsCorpus logs the failure it reports", async () => {
        (vscode.languages.getDiagnostics as jest.Mock).mockImplementation(() => {
            throw new Error("diagnostics unavailable");
        });

        await new CommandsHandler({} as unknown as CommandsDependencies).captureDiagnosticsCorpus();

        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors.mock.calls[0][0]).toBe("CommandsHandler");
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0]).toMatch(/Failed to capture diagnostics/);
    });

    describe("rebuildPathCache", () => {
        function makeCacheHandler(cache: Partial<ProjectPathCache>): CommandsHandler {
            return new CommandsHandler({ projectPathCache: cache as ProjectPathCache } as unknown as CommandsDependencies);
        }

        it("logs a rejected rebuild and tells the user, rather than throwing", async () => {
            const handler = makeCacheHandler({
                rebuildCache: jest.fn().mockRejectedValue(new Error("workspace scan failed")),
                getStats: jest.fn(),
            });

            await expect(handler.rebuildPathCache()).resolves.toBeUndefined();

            expect(errors).toHaveBeenCalledTimes(1);
            expect(errors.mock.calls[0][0]).toBe("CommandsHandler");
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
            expect((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0]).toMatch(/Failed to rebuild project path cache: workspace scan failed/);
        });

        it("logs a throwing getStats, which runs after the progress notification closes", async () => {
            const handler = makeCacheHandler({
                rebuildCache: jest.fn().mockResolvedValue(undefined),
                getStats: jest.fn().mockImplementation(() => {
                    throw new Error("cache state unreadable");
                }),
            });

            await expect(handler.rebuildPathCache()).resolves.toBeUndefined();

            expect(errors).toHaveBeenCalledTimes(1);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("still reports the rebuilt counts when nothing fails", async () => {
            const handler = makeCacheHandler({
                rebuildCache: jest.fn().mockResolvedValue(undefined),
                getStats: jest.fn().mockReturnValue({ identifiers: 12, files: 3 }),
            });

            await handler.rebuildPathCache();

            expect(errors).not.toHaveBeenCalled();
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Project path cache rebuilt: 12 identifiers from 3 files");
        });
    });

    describe("makeModulePublic", () => {
        const REQUEST = {
            targetPath: "/mygame@fortnite.com/mygame/Gadgets/Tools",
            importerPath: "/mygame@fortnite.com/mygame/Scripts",
            moduleName: "Tools",
        };

        /**
         * The document is the middle hop of provider - command - writer, and
         * dropping it here reverts to the first workspace folder silently:
         * every other test in the chain still passes.
         */
        it("forwards the document the quick fix named to the writer", async () => {
            const makeModulePublic = jest.fn().mockResolvedValue(undefined);
            const handler = new CommandsHandler({ moduleVisibilityWriter: { makeModulePublic } } as unknown as CommandsDependencies);
            const source = vscode.Uri.file("/second/Content/Scripts/main.verse");

            await handler.makeModulePublic(REQUEST, source);

            expect(makeModulePublic).toHaveBeenCalledWith(REQUEST, source);
        });
    });
});

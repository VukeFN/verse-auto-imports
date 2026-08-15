import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CommandsHandler, CommandsDependencies } from "../commands";
import { StatusBarHandler } from "../ui";
import { DiagnosticsHandler } from "../diagnostics";
import { ImportHandler, ImportCodeActionProvider, ImportCodeLensProvider, ImportDocumentEditor, ImportFormatter } from "../imports";
import { RESOURCE_SCOPED } from "../utils";

/**
 * Guard for two defects with one cause: settings access owned by nobody.
 *
 * No setting declared a scope, so a folder's value was ignored without error in
 * the multi-root workspace UEFN generates; and every write hardcoded
 * ConfigurationTarget.Global, so a workspace-level override permanently
 * shadowed every toggle - the toggle changed a value nothing read, which reads
 * to the user as a control that does nothing.
 *
 * Both are pinned at the entry points a user reaches, not at the settings
 * module beneath them: the module can be correct while the path that calls it
 * passes no resource, which is exactly what the reported defect was.
 */

const getConfiguration = vscode.workspace.getConfiguration as unknown as jest.Mock;

/** The resource every read below is expected to be scoped to. */
const DOCUMENT_PATH = "C:\\Project\\Content\\Scripts\\device.verse";

function makeDocument(text = "using { /Fortnite.com/Devices }\r\n"): vscode.TextDocument {
    return {
        getText: () => text,
        uri: vscode.Uri.file(DOCUMENT_PATH),
        fileName: DOCUMENT_PATH,
        languageId: "verse",
    } as unknown as vscode.TextDocument;
}

/** Every resource getConfiguration was asked for, in call order. */
function scopesAskedFor(): unknown[] {
    return getConfiguration.mock.calls.filter((call) => call[0] === "verseAutoImports").map((call) => call[1]);
}

describe("every contributed setting declares a scope", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    const registered: Record<string, { scope?: string }> = manifest.contributes.configuration.properties;

    // The whole read half of the defect is that an undeclared scope silently
    // defaults to window, so this is the assertion that stops it recurring: a
    // setting added without a scope fails here rather than shipping it again.
    it("names a scope on every one, so none defaults to window by accident", () => {
        const undeclared = Object.keys(registered).filter((key) => !registered[key].scope);

        expect(undeclared).toEqual([]);
    });

    it("uses only the two scopes this extension has decided between", () => {
        const used = [...new Set(Object.values(registered).map((property) => property.scope))].sort();

        expect(used).toEqual(["resource", "window"]);
    });

    // The write path decides whether a workspace folder may hold a setting from
    // RESOURCE_SCOPED, because inspect() cannot tell it: a single-root
    // workspace reports a folder value for window-scoped settings too, and
    // update() rejects those. The manifest is the source of truth, so the two
    // drifting apart is a thrown write at a user's keystroke - fail here first.
    it("keeps RESOURCE_SCOPED in step with the scopes the manifest declares", () => {
        const declared = Object.keys(registered)
            .filter((key) => registered[key].scope === "resource")
            .map((key) => key.replace("verseAutoImports.", ""))
            .sort();

        expect(declared).toEqual([...RESOURCE_SCOPED].sort());
    });
});

describe("reads are scoped to the document they decide about", () => {
    afterEach(() => {
        getConfiguration.mockClear();
    });

    it("provideCodeActions asks for the edited document's configuration", async () => {
        const importHandler = { extractImportSuggestions: jest.fn().mockResolvedValue([]) } as unknown as ImportHandler;
        const provider = new ImportCodeActionProvider(vscode.window.createOutputChannel("test"), importHandler);

        await provider.provideCodeActions(
            makeDocument(),
            {} as unknown as vscode.Range,
            { diagnostics: [{ message: "Unknown identifier `button_device`", range: { start: { line: 7 } } }] } as unknown as vscode.CodeActionContext,
            {} as unknown as vscode.CancellationToken,
        );

        expect(scopesAskedFor()).toContainEqual(vscode.Uri.file(DOCUMENT_PATH));
    });

    it("provideCodeLenses asks for the lensed document's configuration", async () => {
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));

        await provider.provideCodeLenses(makeDocument(), {} as vscode.CancellationToken);

        expect(scopesAskedFor()).toContainEqual(vscode.Uri.file(DOCUMENT_PATH));
    });

    // These four decide the text written into the user's file - the syntax, the
    // ordering, the grouping and the spacing after the block. They are the
    // reads a wrong scope corrupts a document with, so they matter most.
    it.each([
        ["addImportsToDocument", (editor: ImportDocumentEditor, document: vscode.TextDocument) => editor.addImportsToDocument(document, ["using { /Fortnite.com/Devices }"])],
        ["organizeImports", (editor: ImportDocumentEditor, document: vscode.TextDocument) => editor.organizeImports(document, [])],
        ["computeEmptyLinesAfterImportsEdits", async (editor: ImportDocumentEditor, document: vscode.TextDocument) => void editor.computeEmptyLinesAfterImportsEdits(document)],
    ])("%s asks for the edited document's configuration", async (_name, run) => {
        const editor = new ImportDocumentEditor(vscode.window.createOutputChannel("test"), new ImportFormatter());

        await run(editor, makeDocument());

        expect(scopesAskedFor()).toContainEqual(vscode.Uri.file(DOCUMENT_PATH));
    });

    // The authoritative auto-import decision, per the comment on the
    // onDidChangeDiagnostics listener: the debounce callback re-reads when its
    // timer fires, and that read is the one that governs.
    it("the debounce callback asks for the diagnosed document's configuration", async () => {
        jest.useFakeTimers();
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([{ message: "Unknown identifier `button_device`.", range: { start: { line: 7 } } }]);

        try {
            const importHandler = {
                extractImportSuggestions: jest.fn().mockResolvedValue([]),
                addImportsToDocument: jest.fn().mockResolvedValue(true),
            } as unknown as ImportHandler;
            const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
            handler.setDelay(10);

            await handler.handle(makeDocument());
            await jest.advanceTimersByTimeAsync(10);

            expect(scopesAskedFor()).toContainEqual(vscode.Uri.file(DOCUMENT_PATH));
        } finally {
            jest.clearAllTimers();
            jest.useRealTimers();
            (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([]);
        }
    });
});

describe("a toggle writes where the override already lives", () => {
    /** A configuration whose inspect() reports the workspace holding the value. */
    function overriddenAtWorkspace(): { update: jest.Mock } {
        const config = {
            get: jest.fn().mockReturnValue(false),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue({ key: "verseAutoImports.general.autoImport", workspaceValue: false }),
        };
        getConfiguration.mockReturnValue(config);
        return config;
    }

    afterEach(() => {
        getConfiguration.mockReset();
        getConfiguration.mockReturnValue({
            get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue(undefined),
        });
    });

    // The reported defect: a team repo commits general.autoImport false in
    // .vscode/settings.json, the user clicks the toggle, the write lands in
    // user settings, the workspace value keeps winning, and the row still reads
    // Disabled. Writing Global here is what made the control inert.
    it("toggleAutoImport writes to the workspace, not over it into user settings", async () => {
        const config = overriddenAtWorkspace();
        const handler = new CommandsHandler({
            statusBarHandler: { updateDisplay: jest.fn() } as unknown as StatusBarHandler,
        } as unknown as CommandsDependencies);

        await handler.toggleAutoImport();

        expect(config.update).toHaveBeenCalledWith("general.autoImport", true, vscode.ConfigurationTarget.Workspace);
    });

    it("resolves the toggle against the file the user is editing", async () => {
        overriddenAtWorkspace();
        const uri = vscode.Uri.file(DOCUMENT_PATH);
        (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = { document: { uri } };

        try {
            await new CommandsHandler({
                statusBarHandler: { updateDisplay: jest.fn() } as unknown as StatusBarHandler,
            } as unknown as CommandsDependencies).toggleAutoImport();

            expect(scopesAskedFor()).toContainEqual(uri);
        } finally {
            (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
        }
    });
});

// One toggle had two implementations: the row wrote configuration itself
// instead of invoking the command that already existed, and inverted a value
// snapshotted when the menu opened rather than read at click time.
describe("the status menu drives its toggles through the registered commands", () => {
    /** Every command id CommandsHandler registers, taken from the real registration. */
    function registeredCommandIds(): string[] {
        const register = vscode.commands.registerCommand as jest.Mock;
        register.mockClear();

        new CommandsHandler({
            statusBarHandler: { updateDisplay: jest.fn() } as unknown as StatusBarHandler,
        } as unknown as CommandsDependencies).registerAll({ subscriptions: [] } as unknown as vscode.ExtensionContext);

        return register.mock.calls.map((call) => call[0] as string);
    }

    afterEach(() => {
        jest.clearAllMocks();
        getConfiguration.mockReturnValue({
            get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue(undefined),
        });
    });

    /** Opens the menu, picks the row whose label contains `label`, and runs it. */
    async function pickMenuRow(label: string): Promise<{ update: jest.Mock }> {
        const config = {
            get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue(undefined),
        };
        getConfiguration.mockReturnValue(config);
        (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: Array<{ label: string; action?: () => Promise<void> }>) => items.find((item) => item.label.includes(label)));

        await new StatusBarHandler(vscode.window.createOutputChannel("test")).showMenu();
        return config;
    }

    // Each row's label paired with the command it must dispatch instead of
    // writing. A row that writes its own copy is the defect; a row naming a
    // command nothing registers is the way the fix silently rots.
    const DELEGATED_ROWS: Array<[string, string]> = [
        ["Auto Import", "verseAutoImports.toggleAutoImport"],
        ["Preserve Import Locations", "verseAutoImports.togglePreserveLocations"],
        ["Dot Syntax", "verseAutoImports.toggleImportSyntax"],
        ["Path Conversion Helper", "verseAutoImports.toggleFullPathCodeLens"],
        ["Use Digest Files", "verseAutoImports.toggleDigestFiles"],
    ];

    it.each(DELEGATED_ROWS)("the %s row invokes its command and writes nothing itself", async (label, command) => {
        const config = await pickMenuRow(label);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(command);
        expect(config.update).not.toHaveBeenCalled();
    });

    it("dispatches only commands that are actually registered", () => {
        const registered = registeredCommandIds();

        expect(registered).toEqual(expect.arrayContaining(DELEGATED_ROWS.map(([, command]) => command)));
    });
});

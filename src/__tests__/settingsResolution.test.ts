import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CommandsHandler, CommandsDependencies } from "../commands";
import { StatusBarHandler } from "../ui";
import { DiagnosticsHandler } from "../diagnostics";
import { ImportHandler, ImportCodeActionProvider, ImportCodeLensProvider } from "../imports";

/**
 * Guard for issue #359's defect class, in both halves.
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

    // The whole read half of #359 is that an undeclared scope silently defaults
    // to window, so this is the assertion that stops it recurring: a setting
    // added without a scope fails here rather than shipping the defect again.
    it("names a scope on every one, so none defaults to window by accident", () => {
        const undeclared = Object.keys(registered).filter((key) => !registered[key].scope);

        expect(undeclared).toEqual([]);
    });

    it("uses only the two scopes this extension has decided between", () => {
        const used = [...new Set(Object.values(registered).map((property) => property.scope))].sort();

        expect(used).toEqual(["resource", "window"]);
    });

    // resource is a promise that a folder's value is honoured. It is declared
    // only where a read passes a resource, so this list and the threading in
    // the reads below have to move together.
    it("declares resource on exactly the settings a scoped read consumes", () => {
        const resourceScoped = Object.keys(registered)
            .filter((key) => registered[key].scope === "resource")
            .sort();

        expect(resourceScoped).toEqual(
            [
                "verseAutoImports.behavior.emptyLinesAfterImports",
                "verseAutoImports.behavior.importGrouping",
                "verseAutoImports.behavior.importSyntax",
                "verseAutoImports.behavior.multiOptionStrategy",
                "verseAutoImports.behavior.preserveImportLocations",
                "verseAutoImports.behavior.sortImportsAlphabetically",
                "verseAutoImports.general.autoImport",
                "verseAutoImports.moduleVisibility.definitionsFileName",
                "verseAutoImports.pathConversion.enableCodeLens",
                "verseAutoImports.quickFix.showDescriptions",
                "verseAutoImports.quickFix.sortAlphabetically",
            ].sort(),
        );
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

// #359 names this as the second implementation of one toggle: the row wrote
// configuration itself instead of invoking the command that already existed,
// and inverted a value snapshotted when the menu opened rather than read at
// click time.
describe("the status menu drives its toggles through the registered commands", () => {
    afterEach(() => {
        jest.clearAllMocks();
        getConfiguration.mockReturnValue({
            get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue(undefined),
        });
    });

    /** Opens the menu, picks the row whose label contains `label`, and runs it. */
    async function pickMenuRow(label: string): Promise<void> {
        (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: Array<{ label: string; action?: () => Promise<void> }>) => items.find((item) => item.label.includes(label)));

        await new StatusBarHandler(vscode.window.createOutputChannel("test")).showMenu();
    }

    it("the Auto Import row invokes the command and writes nothing itself", async () => {
        const config = {
            get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue(undefined),
        };
        getConfiguration.mockReturnValue(config);

        await pickMenuRow("Auto Import");

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("verseAutoImports.toggleAutoImport");
        expect(config.update).not.toHaveBeenCalled();
    });
});

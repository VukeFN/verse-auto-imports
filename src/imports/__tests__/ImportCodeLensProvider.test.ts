import * as vscode from "vscode";
import { ImportCodeLensProvider } from "../ImportCodeLensProvider";

/** The registered default for pathConversion.codeLensHideDelay. */
const DEFAULT_HIDE_DELAY_MS = 1000;

/**
 * A document that only carries what provideCodeLenses reads: its text, a uri to
 * key hover state on, and a name for the log line.
 */
function documentWith(text: string, fsPath = "C:\\project\\Content\\Main.verse"): vscode.TextDocument {
    return {
        getText: () => text,
        uri: vscode.Uri.file(fsPath),
        fileName: fsPath,
        languageId: "verse",
    } as unknown as vscode.TextDocument;
}

/** Titles are what the user sees, and they identify each lens unambiguously. */
async function lensTitlesFor(text: string): Promise<string[]> {
    const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
    const lenses = await provider.provideCodeLenses(documentWith(text), {} as vscode.CancellationToken);
    return lenses.map((lens) => lens.command?.title ?? "");
}

describe("ImportCodeLensProvider.provideCodeLenses", () => {
    beforeEach(() => {
        // "always" visibility, so no hover state has to be simulated. Every
        // other setting keeps the caller's default.
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => (key === "pathConversion.codeLensVisibility" ? "always" : defaultValue),
            update: jest.fn(),
        });
    });

    it("offers an absolute-path lens on a live relative import", () => {
        return expect(lensTitlesFor("using { Gadgets.Tools }\n\ncode()")).resolves.toEqual(["$(arrow-both)  Use absolute path"]);
    });

    it("offers a relative-path lens on a live project import", () => {
        return expect(lensTitlesFor("using { /mygame@fortnite.com/mygame/Gadgets }\n\ncode()")).resolves.toEqual(["$(arrow-both)  Use relative path"]);
    });

    it("offers an absolute-path lens on a bare-identifier folder import", () => {
        // A file-level `using { Features }` is a same-directory folder module,
        // and the shared scanner says so. The per-line detection this replaced
        // read the bare identifier as a local-scope using and offered nothing.
        return expect(lensTitlesFor("using { Features }\n\ncode()")).resolves.toEqual(["$(arrow-both)  Use absolute path"]);
    });

    it("offers nothing on a built-in module", () => {
        return expect(lensTitlesFor("using { /Verse.org/Simulation }\n\ncode()")).resolves.toEqual([]);
    });

    it("offers nothing on an import inside a block comment", () => {
        // The lens used to appear here, and acting on it edited a line inside
        // the comment.
        return expect(lensTitlesFor("<#\nusing { /mygame@fortnite.com/mygame/Gadgets }\n#>\n\ncode()")).resolves.toEqual([]);
    });

    it("offers nothing on a module-scoped import inside a module body", () => {
        return expect(lensTitlesFor("MyModule := module:\n    using { Gadgets.Tools }\n\ncode()")).resolves.toEqual([]);
    });

    it("offers nothing on an import whose own line opens a block comment", () => {
        return expect(lensTitlesFor("using { Gadgets.Tools } <#\ndisabled\n#>\n\ncode()")).resolves.toEqual([]);
    });

    it("does not count commented-out imports towards the convert-all lens", () => {
        // One live relative import and one inside a comment is not "multiple",
        // so the convert-all lens must not appear alongside the single one.
        const text = "using { Gadgets.Tools }\n<#\nusing { Other.Tools }\n#>\n\ncode()";
        return expect(lensTitlesFor(text)).resolves.toEqual(["$(arrow-both)  Use absolute path"]);
    });

    it("adds the convert-all lens once a second live import of the same kind exists", () => {
        const text = "using { Gadgets.Tools }\nusing { Other.Tools }\n\ncode()";
        return expect(lensTitlesFor(text)).resolves.toEqual([
            "$(arrow-both)  Use absolute path",
            "$(arrow-swap)  Use absolute paths for all",
            "$(arrow-both)  Use absolute path",
            "$(arrow-swap)  Use absolute paths for all",
        ]);
    });

    it("ends the lens range at the true end of a CRLF line", async () => {
        // The end column comes from the split line's length, so splitting on
        // "\n" puts it one past the end of the line on every CRLF document.
        // Real VS Code clamps that overshoot, which is exactly why nothing here
        // can be left resting on it.
        const importLine = "using { Gadgets.Tools }";
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));

        const lenses = await provider.provideCodeLenses(documentWith([importLine, "", "code()"].join("\r\n")), {} as vscode.CancellationToken);

        expect(lenses).toHaveLength(1);
        expect(lenses[0].range.start).toEqual({ line: 0, character: 0 });
        expect(lenses[0].range.end).toEqual({ line: 0, character: importLine.length });
    });
});

// Regression for #142: the provider discarded both listener Disposables and had
// no dispose() at all, and extension.ts registered only the CodeLens
// registration, which disposes the registration and not the provider. After
// deactivation onDidChangeTextDocument - which fires on every keystroke in
// every document in the window - kept calling in, and a hide timer (delay
// configurable up to 10000 ms) could still fire seconds later.
describe("ImportCodeLensProvider hide timers and teardown", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        // "hover" visibility, so setHoverState arms a real hide timer; in
        // "always" mode it returns before scheduling anything.
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => (key === "pathConversion.codeLensVisibility" ? "hover" : defaultValue),
            update: jest.fn(),
        });
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    /** The dispose function of every listener registered since the last clear. */
    function registeredDisposals(): jest.Mock[] {
        const registrars = [vscode.workspace.onDidChangeConfiguration, vscode.workspace.onDidChangeTextDocument];
        return registrars.flatMap((registrar) => (registrar as jest.Mock).mock.results.map((result) => result.value.dispose as jest.Mock));
    }

    it("disposes every listener it registered", () => {
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));

        const disposals = registeredDisposals();
        expect(disposals).toHaveLength(2);

        provider.dispose();

        for (const dispose of disposals) {
            expect(dispose).toHaveBeenCalledTimes(1);
        }
    });

    it("clears a pending hide timer on dispose", () => {
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
        const documentUri = vscode.Uri.file("C:\\project\\Content\\Main.verse").toString();

        provider.setHoverState(documentUri, true, 0);
        provider.setHoverState(documentUri, false);
        expect(jest.getTimerCount()).toBe(1);

        provider.dispose();

        expect(jest.getTimerCount()).toBe(0);
    });

    it("does not let an untracked hide timer blank the lens out from under the cursor", async () => {
        // Hovering a non-import line and then moving onto an import within the
        // hide delay. The orphaned hide timer used to survive the move and fire
        // anyway, hiding a lens the user had just hovered.
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
        const document = documentWith("using { Gadgets.Tools }\n\ncode()");
        const documentUri = document.uri.toString();

        provider.setHoverState(documentUri, false);
        provider.setHoverState(documentUri, true, 0);
        jest.advanceTimersByTime(DEFAULT_HIDE_DELAY_MS);

        const lenses = await provider.provideCodeLenses(document, {} as vscode.CancellationToken);
        expect(lenses).toHaveLength(1);
    });

    it("clears a hide timer armed without a preceding hover", () => {
        // The hover provider reports every non-import line as hovering=false,
        // so this is the path the extension takes most. The timer used to be
        // created and never stored, which put it beyond the reach of dispose
        // and of keepHoverStateActive alike.
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
        const documentUri = vscode.Uri.file("C:\\project\\Content\\Main.verse").toString();

        provider.setHoverState(documentUri, false);
        expect(jest.getTimerCount()).toBe(1);

        provider.dispose();

        expect(jest.getTimerCount()).toBe(0);
    });
});

// Both hover maps are keyed by document.uri.toString(), and two Verse files
// that share a basename differ only in their folder. Any key that collapsed
// them - a basename, or a Uri carrying no toString of its own - would let one
// file's hover decide whether the other file's lenses appear.
describe("ImportCodeLensProvider per-document hover state", () => {
    /** One relative import, so a visible document offers exactly one lens. */
    const IMPORT_TEXT = "using { Gadgets.Tools }\n\ncode()";
    const WEAPONS_UTILS = "C:\\project\\Content\\Weapons\\utils.verse";
    const UI_UTILS = "C:\\project\\Content\\UI\\utils.verse";

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        // "hover" visibility, so the lenses are a readout of the hover state.
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => (key === "pathConversion.codeLensVisibility" ? "hover" : defaultValue),
            update: jest.fn(),
        });
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("offers nothing on a document that was never hovered", async () => {
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));

        const lenses = await provider.provideCodeLenses(documentWith(IMPORT_TEXT), {} as vscode.CancellationToken);

        expect(lenses).toEqual([]);
    });

    it("confines a hover to the document hovered, not its same-named neighbour", async () => {
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
        const weapons = documentWith(IMPORT_TEXT, WEAPONS_UTILS);
        const ui = documentWith(IMPORT_TEXT, UI_UTILS);

        provider.setHoverState(weapons.uri.toString(), true, 0);

        await expect(provider.provideCodeLenses(weapons, {} as vscode.CancellationToken)).resolves.toHaveLength(1);
        await expect(provider.provideCodeLenses(ui, {} as vscode.CancellationToken)).resolves.toEqual([]);
    });

    it("confines a hide timer to the document it was armed for", async () => {
        const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
        const weapons = documentWith(IMPORT_TEXT, WEAPONS_UTILS);
        const ui = documentWith(IMPORT_TEXT, UI_UTILS);

        provider.setHoverState(weapons.uri.toString(), true, 0);
        provider.setHoverState(ui.uri.toString(), true, 0);
        provider.setHoverState(weapons.uri.toString(), false);
        jest.advanceTimersByTime(DEFAULT_HIDE_DELAY_MS);

        await expect(provider.provideCodeLenses(weapons, {} as vscode.CancellationToken)).resolves.toEqual([]);
        await expect(provider.provideCodeLenses(ui, {} as vscode.CancellationToken)).resolves.toHaveLength(1);
    });
});

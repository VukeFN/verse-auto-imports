import * as vscode from "vscode";
import { DiagnosticsHandler } from "../DiagnosticsHandler";
import { ImportHandler } from "../../imports";

describe("DiagnosticsHandler.shouldProcessUri", () => {
    const fileUri = (fsPath: string) => ({ scheme: "file", fsPath });

    it("accepts a regular .verse file", () => {
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\Project\\Content\\Scripts\\device.verse"))).toBe(true);
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("/home/user/Content/device.verse"))).toBe(true);
    });

    it("rejects VS Code internal document schemes", () => {
        // Replace-preview buffers appear in diagnostics events while an edit
        // preview is in flight; opening them throws.
        expect(DiagnosticsHandler.shouldProcessUri({ scheme: "private", fsPath: "/replacePreview" })).toBe(false);
        expect(DiagnosticsHandler.shouldProcessUri({ scheme: "git", fsPath: "/repo/file.verse" })).toBe(false);
        expect(DiagnosticsHandler.shouldProcessUri({ scheme: "output", fsPath: "extension-output" })).toBe(false);
        expect(DiagnosticsHandler.shouldProcessUri({ scheme: "untitled", fsPath: "Untitled-1" })).toBe(false);
    });

    it("rejects Epic's generated digest files", () => {
        // Digest files carry permanent LSP errors in a UEFN workspace and are
        // read-only reference material; the extension must never process them.
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\VerseProject\\Fortnite\\Fortnite.digest.verse"))).toBe(false);
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\VerseProject\\P-Assets\\Assets.digest.verse"))).toBe(false);
    });

    it("rejects non-verse files", () => {
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\Project\\Content\\readme.md"))).toBe(false);
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\Project\\project.uefnproject"))).toBe(false);
    });

    it("is case-insensitive about the extension", () => {
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\Project\\Device.VERSE"))).toBe(true);
        expect(DiagnosticsHandler.shouldProcessUri(fileUri("C:\\Project\\Assets.DIGEST.verse"))).toBe(false);
    });
});

describe("DiagnosticsHandler.isUriInScope", () => {
    // Built through the shared mock so the uris stringify the way the gate
    // compares them; a plain object literal would compare "[object Object]"
    // against itself and pass whatever the scope said.
    const active = vscode.Uri.file("C:\\Project\\Content\\active.verse");
    const openBackground = vscode.Uri.file("C:\\Project\\Content\\background.verse");
    const neverOpened = vscode.Uri.file("C:\\Project\\Content\\untouched.verse");

    const visibility = {
        openUris: [active.toString(), openBackground.toString()],
        activeUri: active.toString(),
    };

    it("accepts every uri under allFiles", () => {
        expect(DiagnosticsHandler.isUriInScope(neverOpened, "allFiles", visibility)).toBe(true);
        expect(DiagnosticsHandler.isUriInScope(openBackground, "allFiles", visibility)).toBe(true);
    });

    it("under openFiles accepts open documents and rejects one the user never opened", () => {
        expect(DiagnosticsHandler.isUriInScope(active, "openFiles", visibility)).toBe(true);
        expect(DiagnosticsHandler.isUriInScope(openBackground, "openFiles", visibility)).toBe(true);
        // The reported defect: the Verse LSP publishes diagnostics project-wide,
        // so this file would otherwise be opened and edited in the background.
        expect(DiagnosticsHandler.isUriInScope(neverOpened, "openFiles", visibility)).toBe(false);
    });

    it("under activeFile accepts only the focused editor", () => {
        expect(DiagnosticsHandler.isUriInScope(active, "activeFile", visibility)).toBe(true);
        expect(DiagnosticsHandler.isUriInScope(openBackground, "activeFile", visibility)).toBe(false);
        expect(DiagnosticsHandler.isUriInScope(neverOpened, "activeFile", visibility)).toBe(false);
    });

    it("rejects everything under activeFile when no editor has focus", () => {
        // activeTextEditor is undefined when the active tab is not a text
        // editor at all - the settings UI, a webview, an image preview - or
        // when nothing is open. Focusing a panel does not clear it: the API
        // keeps the editor whose input changed most recently.
        const noFocus = { openUris: visibility.openUris, activeUri: undefined };
        expect(DiagnosticsHandler.isUriInScope(active, "activeFile", noFocus)).toBe(false);
    });

    it("under openFiles admits the active document even when no text tab reports it", () => {
        // A .verse file focused in a diff editor has an active editor but a
        // TabInputTextDiff tab, so it never reaches openUris. openFiles is the
        // looser setting; it must never reject what activeFile would accept.
        const inDiffEditor = { openUris: [], activeUri: active.toString() };
        expect(DiagnosticsHandler.isUriInScope(active, "openFiles", inDiffEditor)).toBe(true);
        expect(DiagnosticsHandler.isUriInScope(active, "activeFile", inDiffEditor)).toBe(true);
    });

    it("keeps activeFile a strict subset of openFiles", () => {
        // The property the case above protects, stated directly: anything
        // activeFile accepts, openFiles accepts too.
        for (const uri of [active, openBackground, neverOpened]) {
            if (DiagnosticsHandler.isUriInScope(uri, "activeFile", visibility)) {
                expect(DiagnosticsHandler.isUriInScope(uri, "openFiles", visibility)).toBe(true);
            }
        }
    });

    it("reports which scopes restrict anything", () => {
        expect(DiagnosticsHandler.scopeRestrictsDocuments("openFiles")).toBe(true);
        expect(DiagnosticsHandler.scopeRestrictsDocuments("activeFile")).toBe(true);
        // The callers skip building a visibility snapshot when this is false,
        // so it must agree with isUriInScope's own pass-everything branch.
        expect(DiagnosticsHandler.scopeRestrictsDocuments("allFiles")).toBe(false);
        expect(DiagnosticsHandler.scopeRestrictsDocuments("activefile")).toBe(false);
    });

    it("falls back to allFiles for an unrecognized scope", () => {
        // A mistyped setting must degrade to the previous behavior rather than
        // silently disabling auto-import.
        expect(DiagnosticsHandler.isUriInScope(neverOpened, "activefile", visibility)).toBe(true);
        expect(DiagnosticsHandler.isUriInScope(neverOpened, "", visibility)).toBe(true);
    });

    it("distinguishes uris that share an fsPath but differ in scheme", () => {
        // Comparing by fsPath would let a git: or private: uri for an open
        // file pass the gate; shouldProcessUri rejects those first, so this
        // guards the gate against being reused without it.
        const gitUri = { toString: () => `git:${active.toString()}` };
        expect(DiagnosticsHandler.isUriInScope(gitUri, "openFiles", visibility)).toBe(false);
    });
});

const DELAY_MS = 10;

function makeImportHandler(): ImportHandler {
    return {
        extractImportSuggestions: jest.fn().mockResolvedValue([{ importStatement: "using { /Fortnite.com/Devices }", confidence: "high" }]),
        // true is what a successful applyEdit returns; the handler reads it to
        // decide between the success status message and a warning.
        addImportsToDocument: jest.fn().mockResolvedValue(true),
    } as unknown as ImportHandler;
}

/**
 * Builds the uri with the shared vscode mock, whose Uri carries a per-path
 * toString(); DiagnosticsHandler keys its debounce state on it. A uri that
 * stringifies the same for every path would collapse them all onto one key and
 * hide the very collision the tests below exist to catch.
 */
function makeDocument(fsPath = "C:\\Project\\Content\\device.verse"): vscode.TextDocument {
    return { uri: vscode.Uri.file(fsPath), languageId: "verse" } as unknown as vscode.TextDocument;
}

describe("DiagnosticsHandler auto-import suppression", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([{ message: "Unknown identifier `button_device`." }]);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("auto-imports when nothing suppresses it", async () => {
        const importHandler = makeImportHandler();
        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        await handler.handle(makeDocument());
        await jest.advanceTimersByTimeAsync(DELAY_MS);

        expect(importHandler.addImportsToDocument).toHaveBeenCalledTimes(1);
    });

    // Regression: the debounce timer re-reads the auto-import decision when it
    // fires, so a snooze started while a timer is already pending suppresses
    // that import too. Gating only where the timer is scheduled left a window
    // of one debounce delay (3s by default) in which a snooze was ignored.
    it("does not auto-import when a snooze starts after the timer is scheduled", async () => {
        const importHandler = makeImportHandler();
        let snoozed = false;
        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => snoozed);
        handler.setDelay(DELAY_MS);

        await handler.handle(makeDocument());
        snoozed = true;
        await jest.advanceTimersByTimeAsync(DELAY_MS);

        expect(importHandler.addImportsToDocument).not.toHaveBeenCalled();
    });
});

// Regression for #134: the debounce state was keyed by path.basename, so two
// files sharing a name in different module folders - ordinary in a UEFN
// project - shared one timer and one processing flag. Whichever arrived second
// either cancelled the first file's import or was dropped outright.
describe("DiagnosticsHandler debounce keying", () => {
    const WEAPONS_UTILS = "C:\\Project\\Content\\Weapons\\utils.verse";
    const UI_UTILS = "C:\\Project\\Content\\UI\\utils.verse";

    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([{ message: "Unknown identifier `button_device`." }]);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("does not let one file's diagnostics cancel a same-named file's pending timer", async () => {
        const importHandler = makeImportHandler();
        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        const weaponsUtils = makeDocument(WEAPONS_UTILS);
        const uiUtils = makeDocument(UI_UTILS);

        await handler.handle(weaponsUtils);
        await handler.handle(uiUtils);
        await jest.advanceTimersByTimeAsync(DELAY_MS);

        const imported = (importHandler.addImportsToDocument as jest.Mock).mock.calls.map((call) => call[0]);
        expect(imported).toEqual(expect.arrayContaining([weaponsUtils, uiUtils]));
        expect(imported).toHaveLength(2);
    });

    it("does not drop a same-named file while another is mid-processing", async () => {
        const importHandler = makeImportHandler();
        let releaseFirstImport: () => void = () => {};
        (importHandler.addImportsToDocument as jest.Mock).mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    releaseFirstImport = () => resolve(true);
                }),
        );

        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        const weaponsUtils = makeDocument(WEAPONS_UTILS);
        const uiUtils = makeDocument(UI_UTILS);

        // Let the first file's timer fire and park inside addImportsToDocument,
        // so it is still in processingDocuments when the second file arrives.
        await handler.handle(weaponsUtils);
        await jest.advanceTimersByTimeAsync(DELAY_MS);
        await handler.handle(uiUtils);

        releaseFirstImport();
        await jest.advanceTimersByTimeAsync(DELAY_MS);

        const imported = (importHandler.addImportsToDocument as jest.Mock).mock.calls.map((call) => call[0]);
        expect(imported).toEqual([weaponsUtils, uiUtils]);
    });
});

// Regression for #133: addImportsToDocument returns false when applyEdit is
// rejected, and the status message was shown regardless. The user was told
// imports had been added to a document that never changed.
describe("DiagnosticsHandler auto-import failure reporting", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([{ message: "Unknown identifier `button_device`." }]);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    async function runAutoImport(applyEditResult: boolean): Promise<void> {
        const importHandler = makeImportHandler();
        (importHandler.addImportsToDocument as jest.Mock).mockResolvedValue(applyEditResult);

        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        await handler.handle(makeDocument());
        await jest.advanceTimersByTimeAsync(DELAY_MS);
    }

    it("warns and shows no success message when the edit is rejected", async () => {
        await runAutoImport(false);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(/Could not auto-import/);
        expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    });

    it("reports success and warns about nothing when the edit applies", async () => {
        await runAutoImport(true);

        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledTimes(1);
        expect((vscode.window.setStatusBarMessage as jest.Mock).mock.calls[0][0]).toMatch(/Auto-imported 1 statements/);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

// Regression for #142: the handler had no dispose() and was never added to
// context.subscriptions, so a debounce timer armed by the last keystroke before
// a reload still fired and edited a document belonging to a torn-down
// extension. The debounce delay is user-configurable, 3000 ms by default.
describe("DiagnosticsHandler teardown", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([{ message: "Unknown identifier `button_device`." }]);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("cancels a pending debounce timer on dispose", async () => {
        const importHandler = makeImportHandler();
        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        await handler.handle(makeDocument());
        expect(jest.getTimerCount()).toBe(1);

        handler.dispose();
        expect(jest.getTimerCount()).toBe(0);

        await jest.advanceTimersByTimeAsync(DELAY_MS);
        expect(importHandler.addImportsToDocument).not.toHaveBeenCalled();
    });

    it("does not apply an edit when teardown lands mid-callback", async () => {
        // clearTimeout cannot reach a callback that has already started, and
        // the callback awaits suggestion extraction before it edits. Park it
        // there, tear down, then let it continue.
        const importHandler = makeImportHandler();
        let releaseSuggestions: () => void = () => {};
        (importHandler.extractImportSuggestions as jest.Mock).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseSuggestions = () => resolve([{ importStatement: "using { /Fortnite.com/Devices }", confidence: "high" }]);
                }),
        );

        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        await handler.handle(makeDocument());
        await jest.advanceTimersByTimeAsync(DELAY_MS);

        handler.dispose();
        releaseSuggestions();
        await jest.advanceTimersByTimeAsync(0);

        expect(importHandler.addImportsToDocument).not.toHaveBeenCalled();
    });

    it("arms no new timer for diagnostics that arrive after dispose", async () => {
        // The diagnostics listener awaits openTextDocument before calling
        // handle, so a continuation can resume after teardown and put back
        // the very timer dispose just cancelled.
        const importHandler = makeImportHandler();
        const handler = new DiagnosticsHandler(vscode.window.createOutputChannel("test"), importHandler, () => false);
        handler.setDelay(DELAY_MS);

        handler.dispose();
        await handler.handle(makeDocument());

        expect(jest.getTimerCount()).toBe(0);

        await jest.advanceTimersByTimeAsync(DELAY_MS);
        expect(importHandler.extractImportSuggestions).not.toHaveBeenCalled();
    });
});

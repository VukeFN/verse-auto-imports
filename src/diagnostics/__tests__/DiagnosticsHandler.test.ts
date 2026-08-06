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

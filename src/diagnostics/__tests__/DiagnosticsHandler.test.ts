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
        addImportsToDocument: jest.fn().mockResolvedValue(undefined),
    } as unknown as ImportHandler;
}

/**
 * The uri carries a toString() because DiagnosticsHandler keys its debounce
 * state on it, exactly as vscode.Uri does at runtime. A plain object literal
 * would stringify every document to "[object Object]" and collapse them all
 * onto one key, hiding the very collision these tests exist to catch.
 */
function makeDocument(fsPath = "C:\\Project\\Content\\device.verse"): vscode.TextDocument {
    const uri = {
        scheme: "file",
        fsPath,
        toString: () => `file:///${fsPath.replace(/\\/g, "/")}`,
    };
    return { uri, languageId: "verse" } as unknown as vscode.TextDocument;
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
                new Promise<void>((resolve) => {
                    releaseFirstImport = resolve;
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

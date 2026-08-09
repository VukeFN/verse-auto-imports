import * as vscode from "vscode";
import { activate } from "../extension";

/**
 * Regression for #144: the import-spacing pass ran on onDidSaveTextDocument and
 * applied a WorkspaceEdit, so a file whose import block did not already carry
 * behavior.emptyLinesAfterImports blank lines was edited *after* its own save
 * completed. The tab went dirty the instant the user saved it, and only a
 * second save converged.
 *
 * The pass is a save participant now: it hands VS Code the edits through
 * waitUntil, which applies them before the file is written. So the assertion
 * that matters is the pair - edits offered to the save, and no applyEdit
 * anywhere near it.
 */

/** The subset of ExtensionContext activate() touches. */
interface FakeContext {
    subscriptions: { dispose(): unknown }[];
    workspaceState: { get: jest.Mock; update: jest.Mock; keys: jest.Mock };
}

/** A will-save event, with waitUntil recorded the way VS Code offers it. */
interface FakeWillSaveEvent {
    document: vscode.TextDocument;
    reason: number;
    waitUntil: jest.Mock;
}

function makeContext(): FakeContext {
    return {
        subscriptions: [],
        workspaceState: {
            get: jest.fn().mockReturnValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
            keys: jest.fn().mockReturnValue([]),
        },
    };
}

/**
 * Answers every setting with its default - which is what these tests want for
 * emptyLinesAfterImports, whose default of 1 is the case the bug was reported
 * against. inspect() is part of the contract: the debounce delay is read
 * through it and activation throws without it.
 */
function stubConfiguration(): void {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        inspect: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
    });
}

/**
 * Re-answers emptyLinesAfterImports with `value` for the rest of the test. The
 * listener reads the setting when the save fires, not when it is registered, so
 * this works on the listener activate() already installed.
 */
function stubEmptyLines(value: number): void {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key === "behavior.emptyLinesAfterImports" ? value : defaultValue)),
        inspect: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
    });
}

function fakeDocument(text: string, languageId: string = "verse"): vscode.TextDocument {
    const lines = text.split(/\r?\n/);
    return {
        uri: { toString: () => "file:///test.verse" },
        languageId,
        getText: () => text,
        eol: vscode.EndOfLine.LF,
        lineCount: lines.length,
        lineAt: (index: number) => ({ range: { end: new vscode.Position(index, lines[index].length) } }),
    } as unknown as vscode.TextDocument;
}

/** The listener activate() registered, which is the only handle on it. */
function willSaveListener(): (event: FakeWillSaveEvent) => void {
    const calls = (vscode.workspace.onWillSaveTextDocument as jest.Mock).mock.calls;
    if (calls.length === 0) {
        throw new Error("No onWillSaveTextDocument listener was registered");
    }
    return calls[0][0];
}

function fireWillSave(document: vscode.TextDocument): FakeWillSaveEvent {
    const event: FakeWillSaveEvent = { document, reason: 1, waitUntil: jest.fn() };
    willSaveListener()(event);
    return event;
}

/** The edits the participant offered to the save. */
async function offeredEdits(event: FakeWillSaveEvent): Promise<vscode.TextEdit[]> {
    expect(event.waitUntil).toHaveBeenCalledTimes(1);
    return await event.waitUntil.mock.calls[0][0];
}

const NEEDS_A_BLANK_LINE = ["using { /Fortnite.com/Devices }", "code()"].join("\n");
const ALREADY_SPACED = ["using { /Fortnite.com/Devices }", "", "code()"].join("\n");

beforeEach(() => {
    jest.clearAllMocks();
    stubConfiguration();
    activate(makeContext() as unknown as vscode.ExtensionContext);
});

describe("import spacing on save", () => {
    it("offers the spacing edit to the save instead of applying it afterwards", async () => {
        const event = fireWillSave(fakeDocument(NEEDS_A_BLANK_LINE));

        const edits = await offeredEdits(event);
        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe("\n");
        expect(edits[0].range.start.line).toBe(1);
        // The re-dirty itself: any edit applied around a save is one the save
        // did not write, which is what left the tab modified.
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    // The spacing pass was the only post-save listener, so its registration is
    // the whole of what activate() must no longer do.
    it("registers nothing to run after a save", () => {
        expect(vscode.workspace.onDidSaveTextDocument).not.toHaveBeenCalled();
    });

    it("stays out of the save when the spacing already matches", () => {
        const event = fireWillSave(fakeDocument(ALREADY_SPACED));

        expect(event.waitUntil).not.toHaveBeenCalled();
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    // #242: a fractional setting the UI used to accept gave a difference that
    // no count of real blank lines could close, so every save was handed an
    // edit whose text was empty.
    it("stays out of the save when a fractional setting rounds to the spacing the file has", () => {
        stubEmptyLines(1.5);

        const event = fireWillSave(fakeDocument(["using { /Fortnite.com/Devices }", "", "", "code()"].join("\n")));

        expect(event.waitUntil).not.toHaveBeenCalled();
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    it("ignores a document that is not Verse", () => {
        const event = fireWillSave(fakeDocument(NEEDS_A_BLANK_LINE, "typescript"));

        expect(event.waitUntil).not.toHaveBeenCalled();
    });

    // The old handler was async with no try/catch, so a throw became an
    // unhandled rejection. A save participant that throws blocks the save.
    it("does not throw out of the save when the spacing pass fails", () => {
        const document = fakeDocument(NEEDS_A_BLANK_LINE);
        (document as { getText: () => string }).getText = () => {
            throw new Error("document read failed");
        };

        const event: FakeWillSaveEvent = { document, reason: 1, waitUntil: jest.fn() };

        expect(() => willSaveListener()(event)).not.toThrow();
        expect(event.waitUntil).not.toHaveBeenCalled();
    });
});

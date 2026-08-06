import { StatusBarHandler } from "../StatusBarHandler";
import * as vscode from "vscode";

describe("StatusBarHandler snooze timer lifecycle", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    function makeHandler(): StatusBarHandler {
        const outputChannel = vscode.window.createOutputChannel("test");
        return new StatusBarHandler(outputChannel);
    }

    it("runs exactly one interval while snoozed", () => {
        const handler = makeHandler();
        expect(jest.getTimerCount()).toBe(0);

        handler.startSnooze(5);
        expect(jest.getTimerCount()).toBe(1);
    });

    it("does not leak an interval when snooze is started again while active", () => {
        const clearSpy = jest.spyOn(global, "clearInterval");
        const handler = makeHandler();

        handler.startSnooze(5);
        clearSpy.mockClear();

        // Re-invoke while already snoozed (reachable via the command palette).
        handler.startSnooze(5);

        // The prior interval must have been cleared, leaving exactly one.
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
    });

    it("clears the interval on cancel", () => {
        const handler = makeHandler();
        handler.startSnooze(5);
        expect(jest.getTimerCount()).toBe(1);

        handler.cancelSnooze();
        expect(jest.getTimerCount()).toBe(0);
    });

    it("clears the interval on dispose", () => {
        const handler = makeHandler();
        handler.startSnooze(5);
        expect(jest.getTimerCount()).toBe(1);

        handler.dispose();
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe("StatusBarHandler snooze state", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    function makeHandler(): StatusBarHandler {
        const outputChannel = vscode.window.createOutputChannel("test");
        return new StatusBarHandler(outputChannel);
    }

    function updateMock(): jest.Mock {
        return vscode.workspace.getConfiguration("verseAutoImports").update as jest.Mock;
    }

    it("suppresses auto imports while snoozed", () => {
        const handler = makeHandler();
        expect(handler.isSnoozeActive()).toBe(false);

        handler.startSnooze(5);
        expect(handler.isSnoozeActive()).toBe(true);
    });

    it("stops suppressing auto imports once the snooze expires", () => {
        const handler = makeHandler();
        handler.startSnooze(5);

        jest.advanceTimersByTime(5 * 60000);

        expect(handler.isSnoozeActive()).toBe(false);
    });

    it("stops suppressing auto imports when the snooze is cancelled", () => {
        const handler = makeHandler();
        handler.startSnooze(5);

        handler.cancelSnooze();

        expect(handler.isSnoozeActive()).toBe(false);
    });

    // Regression: a snooze used to write general.autoImport: false into global
    // user settings and only the in-memory interval ever restored it, so a
    // window reload during the snooze disabled auto imports permanently.
    it("does not touch user settings when a snooze starts, expires or is cancelled", () => {
        const update = updateMock();
        const handler = makeHandler();
        update.mockClear();

        handler.startSnooze(5);
        expect(update).not.toHaveBeenCalled();

        jest.advanceTimersByTime(5 * 60000);
        expect(update).not.toHaveBeenCalled();

        handler.startSnooze(5);
        handler.cancelSnooze();
        expect(update).not.toHaveBeenCalled();
    });

    it("leaves nothing disabled behind when disposed mid-snooze", () => {
        const update = updateMock();
        const handler = makeHandler();
        update.mockClear();

        handler.startSnooze(5);
        // Stands in for a window reload: dispose runs, the process goes away.
        handler.dispose();

        expect(update).not.toHaveBeenCalled();

        // A fresh handler, as created on the next activation, is not snoozed.
        expect(makeHandler().isSnoozeActive()).toBe(false);
    });
});

// Regression for #142: the constructor discarded the configuration listener's
// Disposable, so the listener outlived a handler that extension.ts does push
// onto context.subscriptions - full teardown was clearly the intent, and the
// one listener was the hole in it.
describe("StatusBarHandler teardown", () => {
    // Cleared before, not only after: the registration count below would
    // otherwise depend on every earlier block in the file clearing its own.
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("disposes the configuration listener", () => {
        const handler = new StatusBarHandler(vscode.window.createOutputChannel("test"));

        const registrations = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.results;
        expect(registrations).toHaveLength(1);
        const listener = registrations[0].value as { dispose: jest.Mock };

        handler.dispose();

        expect(listener.dispose).toHaveBeenCalledTimes(1);
    });
});

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

// The icon id below must stay in step with the contributes.icons entry in
// package.json; statusBarIcon.test.ts pins that entry against the font itself.
describe("StatusBarHandler display", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    interface ItemSurface {
        text: string;
        tooltip: string;
        accessibilityInformation?: { label: string };
    }

    function makeItem(): { handler: StatusBarHandler; item: ItemSurface } {
        const handler = new StatusBarHandler(vscode.window.createOutputChannel("test"));
        const item = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value as ItemSurface;
        return { handler, item };
    }

    it("shows the icon glyph alone when idle", () => {
        expect(makeItem().item.text).toBe("$(verse-imports-icon)");
    });

    // While snoozed the countdown is the only visible sign that imports are
    // paused, so it must survive the move to an icon-only label.
    it("keeps the snooze countdown beside the icon", () => {
        const { handler, item } = makeItem();

        handler.startSnooze(5);
        expect(item.text).toBe("$(verse-imports-icon) 5:00");

        jest.advanceTimersByTime(90 * 1000);
        expect(item.text).toBe("$(verse-imports-icon) 3:30");
    });

    it("returns to the bare icon when the snooze is cancelled", () => {
        const { handler, item } = makeItem();
        handler.startSnooze(5);

        handler.cancelSnooze();

        expect(item.text).toBe("$(verse-imports-icon)");
    });

    // With no text label left, the tooltip is the only hover identification
    // and accessibilityInformation the only screen-reader surface.
    it("names the item in the tooltip and for screen readers", () => {
        const { item } = makeItem();
        expect(item.tooltip).toBe("Verse Auto Imports");
        expect(item.accessibilityInformation).toEqual({ label: "Verse Auto Imports" });
    });
});

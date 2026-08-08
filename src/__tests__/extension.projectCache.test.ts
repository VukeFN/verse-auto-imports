import * as vscode from "vscode";
import { activate } from "../extension";

/**
 * Regression for #138: cache.enableProjectCache was read at activation, but the
 * cache was constructed and handed to the command dependencies whatever it
 * said. Only initialize() and setupFileWatchers() were gated, so with the
 * feature off the three cache commands still acted on a live cache: the "not
 * enabled" guards in CommandsHandler were unreachable, Show Cache Status
 * reported "Not loaded" instead of "Disabled", and Rebuild Project Path Cache
 * scanned the project and wrote a cache to workspace storage that no watcher
 * would ever invalidate.
 *
 * The setting is also read once, at activation, so these tests pin the reload
 * prompt that tells the user why toggling it changes nothing until then.
 */

/** ProjectPathCache's own storage key; kept in sync with its private static. */
const CACHE_KEY = "projectPathTree";

/** Only ProjectPathCache.setupFileWatchers watches this glob. */
const CACHE_WATCHER_GLOB = "**/*.verse";

const CACHE_SETTING = "cache.enableProjectCache";

/** The subset of ExtensionContext activate() touches, with assertable state. */
interface FakeContext {
    subscriptions: { dispose(): unknown }[];
    workspaceState: { get: jest.Mock; update: jest.Mock; keys: jest.Mock };
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
 * Replaces the shared configuration stub with one that answers the cache
 * setting explicitly. inspect() is part of the contract too: the debounce delay
 * is read through it, and a stub without it throws before activation finishes.
 */
function stubConfiguration(cacheEnabled: boolean): void {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key === CACHE_SETTING ? cacheEnabled : defaultValue)),
        inspect: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
    });
}

function activateWithCache(cacheEnabled: boolean): FakeContext {
    stubConfiguration(cacheEnabled);
    const context = makeContext();
    activate(context as unknown as vscode.ExtensionContext);
    return context;
}

/** The extension keeps no command registry, so registerCommand's calls are it. */
function commandHandler(command: string): (...args: unknown[]) => Promise<void> {
    const call = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(([registered]) => registered === command);
    if (!call) {
        throw new Error(`Command ${command} was never registered`);
    }
    return call[1];
}

function watcherGlobs(): unknown[] {
    return (vscode.workspace.createFileSystemWatcher as jest.Mock).mock.calls.map(([globPattern]) => globPattern);
}

function messageTexts(message: jest.Mock): string[] {
    return message.mock.calls.map(([text]) => String(text));
}

/** Drains the microtask queue so activate()'s fire-and-forget work settles. */
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
    jest.clearAllMocks();
});

describe("activate with cache.enableProjectCache off", () => {
    it("refuses the rebuild command rather than writing an unwatched cache", async () => {
        const context = activateWithCache(false);

        await commandHandler("verseAutoImports.rebuildPathCache")();

        expect(messageTexts(vscode.window.showWarningMessage as jest.Mock)).toContain("Project path cache is not enabled");
        // A rebuild here would scan the project and persist the result, with no
        // watcher behind it to invalidate what it stored.
        expect(vscode.window.withProgress).not.toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it("refuses the clear command", async () => {
        activateWithCache(false);

        await commandHandler("verseAutoImports.clearPathCache")();

        expect(messageTexts(vscode.window.showWarningMessage as jest.Mock)).toContain("Project path cache is not enabled");
    });

    it("reports the cache as disabled, not as loadable but unloaded", async () => {
        activateWithCache(false);

        await commandHandler("verseAutoImports.showCacheStatus")();

        const [status] = messageTexts(vscode.window.showInformationMessage as jest.Mock);
        expect(status).toContain("Project Cache: Disabled");
        expect(status).not.toContain("Not loaded");
    });

    it("neither loads the stored cache nor watches for changes to it", async () => {
        const context = activateWithCache(false);
        await flushAsync();

        expect(context.workspaceState.get).not.toHaveBeenCalledWith(CACHE_KEY);
        expect(watcherGlobs()).not.toContain(CACHE_WATCHER_GLOB);
    });
});

describe("activate with cache.enableProjectCache on", () => {
    it("loads the stored cache and watches for changes to it", async () => {
        const context = activateWithCache(true);
        await flushAsync();

        expect(context.workspaceState.get).toHaveBeenCalledWith(CACHE_KEY);
        expect(watcherGlobs()).toContain(CACHE_WATCHER_GLOB);
    });

    it("lets the cache commands through", async () => {
        activateWithCache(true);

        await commandHandler("verseAutoImports.showCacheStatus")();

        const [status] = messageTexts(vscode.window.showInformationMessage as jest.Mock);
        expect(status).not.toContain("Project Cache: Disabled");
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

describe("toggling cache.enableProjectCache", () => {
    /**
     * Fires every configuration listener activate() registered, with an event
     * that reports only the cache setting as affected. The listeners watching
     * other keys - the debounce delay, the CodeLens options - see false and
     * return, so this needs no knowledge of registration order.
     */
    async function fireCacheSettingChange(): Promise<void> {
        const event = {
            affectsConfiguration: (section: string) => section === `verseAutoImports.${CACHE_SETTING}`,
        } as vscode.ConfigurationChangeEvent;

        const listeners = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.calls.map(([listener]) => listener);
        await Promise.all(listeners.map((listener) => listener(event)));
    }

    it("asks for a reload, because the setting is only read at activation", async () => {
        activateWithCache(true);

        await fireCacheSettingChange();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
        const [text, action] = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0];
        expect(String(text)).toMatch(/Reload the window/);
        expect(action).toBe("Reload Window");
    });

    it("reloads the window when the user accepts", async () => {
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue("Reload Window");
        activateWithCache(true);

        await fireCacheSettingChange();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("does not reload when the user dismisses the prompt", async () => {
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        activateWithCache(true);

        await fireCacheSettingChange();

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});

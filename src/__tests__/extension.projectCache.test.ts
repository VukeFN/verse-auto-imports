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

/** A stored payload, shaped the way ProjectPathCache serializes one. */
const STORED_CACHE = { version: 2, projectName: "MyGame", generatedAt: 0, nodes: [] };

function makeContext(stored: Record<string, unknown> = {}): FakeContext {
    return {
        subscriptions: [],
        workspaceState: {
            get: jest.fn().mockImplementation((key: string) => stored[key]),
            update: jest.fn().mockResolvedValue(undefined),
            keys: jest.fn().mockReturnValue(Object.keys(stored)),
        },
    };
}

/**
 * The setting's current value. Read lazily by the configuration stub, so a test
 * can change it after activation the way the user changes it in the UI.
 */
let cacheSetting = true;

/**
 * Replaces the shared configuration stub with one that answers the cache
 * setting explicitly. inspect() is part of the contract too: the debounce delay
 * is read through it, and a stub without it throws before activation finishes.
 */
function stubConfiguration(): void {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key === CACHE_SETTING ? cacheSetting : defaultValue)),
        inspect: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
    });
}

function activateWithCache(cacheEnabled: boolean, stored: Record<string, unknown> = {}): FakeContext {
    cacheSetting = cacheEnabled;
    stubConfiguration();
    const context = makeContext(stored);
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
        activateWithCache(false);

        await commandHandler("verseAutoImports.rebuildPathCache")();

        expect(messageTexts(vscode.window.showWarningMessage as jest.Mock)).toContain("Project path cache is not enabled");
        // withProgress is the scan: reaching it means the command went on to
        // rebuild and persist a cache no watcher would ever invalidate.
        expect(vscode.window.withProgress).not.toHaveBeenCalled();
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
        expect(status).toBe("Project cache: disabled");
    });

    it("reports the status without blocking the window", async () => {
        activateWithCache(false);

        await commandHandler("verseAutoImports.showCacheStatus")();

        // A second argument would be the options object; { modal: true } here
        // is the regression this pins.
        const call = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0];
        expect(call).toHaveLength(1);
    });

    it("does not watch the project for cache invalidation", async () => {
        activateWithCache(false);
        await flushAsync();

        expect(watcherGlobs()).not.toContain(CACHE_WATCHER_GLOB);
    });

    it("drops a cache an earlier session stored, which nothing can reach now", async () => {
        const context = activateWithCache(false, { [CACHE_KEY]: STORED_CACHE });
        await flushAsync();

        expect(context.workspaceState.update).toHaveBeenCalledWith(CACHE_KEY, undefined);
    });

    it("writes nothing when there is no stored cache to drop", async () => {
        const context = activateWithCache(false);
        await flushAsync();

        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });
});

describe("activate with cache.enableProjectCache on", () => {
    it("loads the stored cache and watches for changes to it", async () => {
        const context = activateWithCache(true, { [CACHE_KEY]: STORED_CACHE });
        await flushAsync();

        expect(context.workspaceState.get).toHaveBeenCalledWith(CACHE_KEY);
        expect(watcherGlobs()).toContain(CACHE_WATCHER_GLOB);
        // The drop is for the disabled path only; here the stored cache is the
        // whole point of the feature.
        expect(context.workspaceState.update).not.toHaveBeenCalledWith(CACHE_KEY, undefined);
    });

    it("lets the cache commands through", async () => {
        activateWithCache(true);

        await commandHandler("verseAutoImports.showCacheStatus")();

        const [status] = messageTexts(vscode.window.showInformationMessage as jest.Mock);
        expect(status).not.toContain("disabled");
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
        cacheSetting = false;

        await fireCacheSettingChange();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
        const [text, action] = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0];
        expect(String(text)).toMatch(/Reload the window/);
        expect(action).toBe("Reload Window");
    });

    it("reloads the window when the user accepts", async () => {
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue("Reload Window");
        activateWithCache(true);
        cacheSetting = false;

        await fireCacheSettingChange();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("does not reload when the user dismisses the prompt", async () => {
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        activateWithCache(true);
        cacheSetting = false;

        await fireCacheSettingChange();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("stays quiet when the value returns to the one activation captured", async () => {
        activateWithCache(true);

        // Off and back on again: the window already behaves as the setting reads.
        cacheSetting = false;
        await fireCacheSettingChange();
        (vscode.window.showInformationMessage as jest.Mock).mockClear();

        cacheSetting = true;
        await fireCacheSettingChange();

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
});

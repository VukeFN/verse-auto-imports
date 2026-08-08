class Position {
    constructor(
        public readonly line: number,
        public readonly character: number,
    ) {}
}

class Range {
    constructor(
        public readonly start: Position,
        public readonly end: Position,
    ) {}
}

interface Command {
    title: string;
    command: string;
    tooltip?: string;
    arguments?: unknown[];
}

class CodeLens {
    constructor(
        public readonly range: Range,
        public readonly command?: Command,
    ) {}
}

/** Registers listeners and fires them synchronously, as VS Code's own does. */
class EventEmitter<T> {
    private readonly listeners: ((value: T) => void)[] = [];

    readonly event = (listener: (value: T) => void): { dispose: () => void } => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                const index = this.listeners.indexOf(listener);
                if (index !== -1) this.listeners.splice(index, 1);
            },
        };
    };

    fire(value: T): void {
        this.listeners.forEach((listener) => listener(value));
    }

    dispose(): void {
        this.listeners.length = 0;
    }
}

interface RecordedEditOperation {
    kind: "insert" | "delete" | "replace";
    uri: unknown;
    position?: Position;
    range?: Range;
    text?: string;
}

/** Records edit operations so tests can assert on them. */
class WorkspaceEdit {
    readonly operations: RecordedEditOperation[] = [];

    insert(uri: unknown, position: Position, text: string): void {
        this.operations.push({ kind: "insert", uri, position, text });
    }

    delete(uri: unknown, range: Range): void {
        this.operations.push({ kind: "delete", uri, range });
    }

    replace(uri: unknown, range: Range, text: string): void {
        this.operations.push({ kind: "replace", uri, range, text });
    }
}

/**
 * Carries a toString() because production code keys per-document state on it -
 * DiagnosticsHandler's debounce maps, CommandsHandler, ImportCodeLensProvider
 * and extension.ts all do. Without one, every instance would inherit
 * Object.prototype.toString, stringify to "[object Object]", and collapse every
 * document in a test onto a single map entry - so a collision test would pass
 * *because* the collision it asserts against happened.
 */
class Uri {
    readonly scheme = "file";

    private constructor(public readonly fsPath: string) {}

    static file(fsPath: string): Uri {
        return new Uri(fsPath);
    }

    /**
     * Joins path segments onto a base URI the way ProjectPathCache does when it
     * resolves a workspace-relative path back to a file. Segments are appended
     * with the platform separator; ".." is not resolved, which real VS Code does.
     */
    static joinPath(base: { fsPath: string }, ...segments: string[]): Uri {
        const separator = base.fsPath.includes("\\") ? "\\" : "/";
        const joined = segments.map((segment) => segment.replace(/[\\/]/g, separator)).join(separator);
        return new Uri(`${base.fsPath.replace(/[\\/]+$/, "")}${separator}${joined}`);
    }

    /**
     * Renders the file URI the way VS Code does for the path shapes these tests
     * use: backslashes become forward slashes, and a Windows drive letter is
     * lowercased with its colon percent-encoded, so "C:\\a\\b.verse" becomes
     * "file:///c%3A/a/b.verse". It is not a general URI encoder - a UNC path, or
     * one holding "#", "?", a space or non-ASCII, would not match real VS Code
     * output.
     */
    toString(): string {
        const forwardSlashed = this.fsPath.replace(/\\/g, "/");
        const rooted = forwardSlashed.startsWith("/") ? forwardSlashed : `/${forwardSlashed}`;
        return `file://${rooted.replace(/^\/([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}%3A`)}`;
    }
}

class RelativePattern {
    constructor(
        public readonly base: unknown,
        public readonly pattern: string,
    ) {}
}

class Disposable {
    constructor(private readonly callOnDispose: () => void) {}

    static from(...disposables: Array<{ dispose(): unknown }>): Disposable {
        return new Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
    }

    dispose(): void {
        this.callOnDispose();
    }
}

type WatcherHandler = (uri: Uri) => void;

/**
 * Records the handlers a watcher registers so tests can fire file events and
 * assert on what the extension does with them.
 */
class FileSystemWatcher {
    readonly changeHandlers: WatcherHandler[] = [];
    readonly createHandlers: WatcherHandler[] = [];
    readonly deleteHandlers: WatcherHandler[] = [];
    disposed = false;

    constructor(public readonly globPattern: unknown) {}

    onDidChange(handler: WatcherHandler): { dispose: () => void } {
        this.changeHandlers.push(handler);
        return { dispose: () => {} };
    }

    onDidCreate(handler: WatcherHandler): { dispose: () => void } {
        this.createHandlers.push(handler);
        return { dispose: () => {} };
    }

    onDidDelete(handler: WatcherHandler): { dispose: () => void } {
        this.deleteHandlers.push(handler);
        return { dispose: () => {} };
    }

    dispose(): void {
        this.disposed = true;
    }

    fireChange(fsPath: string): void {
        this.changeHandlers.forEach((handler) => handler(Uri.file(fsPath)));
    }

    fireCreate(fsPath: string): void {
        this.createHandlers.forEach((handler) => handler(Uri.file(fsPath)));
    }

    fireDelete(fsPath: string): void {
        this.deleteHandlers.forEach((handler) => handler(Uri.file(fsPath)));
    }
}

const workspace = {
    getConfiguration: jest.fn().mockReturnValue({
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn().mockResolvedValue(undefined),
    }),
    // A fresh disposable per registration, as real VS Code returns. A single
    // shared one would make "every listener this class registered was
    // disposed" unassertable: one dispose() call would satisfy all of them.
    onDidChangeConfiguration: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    onDidChangeTextDocument: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    onDidSaveTextDocument: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    applyEdit: jest.fn().mockResolvedValue(true),
    workspaceFolders: undefined as { uri: { fsPath: string }; name: string; index: number }[] | undefined,
    findFiles: jest.fn().mockResolvedValue([]),
    createFileSystemWatcher: jest.fn().mockImplementation((globPattern: unknown) => new FileSystemWatcher(globPattern)),
    // Empty by default so a test that only needs the scan to complete does not
    // have to stub it; tests that care about parse timing replace it.
    openTextDocument: jest.fn().mockResolvedValue({ getText: () => "" }),
    /**
     * Renders a path relative to the first workspace folder, forward-slashed, as
     * the scanner and the cache watchers expect; anything outside it comes back
     * unchanged. Real VS Code relativizes against whichever folder contains the
     * path and honours the includeWorkspaceFolder argument, so a test covering
     * the multi-root UEFN workspace needs more than this.
     */
    asRelativePath: jest.fn().mockImplementation((target: { fsPath: string } | string) => {
        const fsPath = typeof target === "string" ? target : target.fsPath;
        const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
        const normalized = fsPath.replace(/\\/g, "/");
        if (!root) {
            return normalized;
        }
        const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
        return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : normalized;
    }),
};

const window = {
    createOutputChannel: jest.fn().mockReturnValue({
        appendLine: jest.fn(),
        show: jest.fn(),
        clear: jest.fn(),
        dispose: jest.fn(),
    }),
    createStatusBarItem: jest.fn().mockImplementation(() => ({
        text: "",
        tooltip: "",
        command: "",
        name: "",
        color: undefined,
        backgroundColor: undefined,
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
    })),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showQuickPick: jest.fn(),
    setStatusBarMessage: jest.fn(),
    /**
     * Runs the task straight away, as real VS Code does, so a command wrapped
     * in a progress notification is still observable from a test. The progress
     * and cancellation arguments are the minimum the callers read.
     */
    withProgress: jest
        .fn()
        .mockImplementation(<T>(_options: unknown, task: (progress: { report: () => void }, token: { isCancellationRequested: boolean }) => Thenable<T>) =>
            task({ report: () => {} }, { isCancellationRequested: false }),
        ),
};

const languages = {
    getDiagnostics: jest.fn().mockReturnValue([]),
    onDidChangeDiagnostics: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    registerCodeActionsProvider: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    registerCodeLensProvider: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    registerHoverProvider: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
};

/**
 * registerCommand records the handler in its own mock.calls, which is how a
 * test gets at a command body: the extension keeps no registry of its own.
 */
const commands = {
    registerCommand: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    executeCommand: jest.fn().mockResolvedValue(undefined),
};

const ProgressLocation = {
    SourceControl: 1,
    Window: 10,
    Notification: 15,
};

const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
};

const StatusBarAlignment = {
    Left: 1,
    Right: 2,
};

const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
};

const EndOfLine = {
    LF: 1,
    CRLF: 2,
};

export {
    workspace,
    window,
    languages,
    commands,
    DiagnosticSeverity,
    StatusBarAlignment,
    ConfigurationTarget,
    ProgressLocation,
    EndOfLine,
    Position,
    Range,
    WorkspaceEdit,
    Uri,
    RelativePattern,
    Disposable,
    FileSystemWatcher,
    CodeLens,
    EventEmitter,
};

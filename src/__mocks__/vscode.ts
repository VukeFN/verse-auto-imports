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

    get isEmpty(): boolean {
        return this.start.line === this.end.line && this.start.character === this.end.character;
    }
}

class TextEdit {
    constructor(
        public readonly range: Range,
        public readonly newText: string,
    ) {}

    static insert(position: Position, newText: string): TextEdit {
        return new TextEdit(new Range(position, position), newText);
    }

    static delete(range: Range): TextEdit {
        return new TextEdit(range, "");
    }

    static replace(range: Range, newText: string): TextEdit {
        return new TextEdit(range, newText);
    }
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
    kind: "insert" | "delete" | "replace" | "createFile";
    uri: unknown;
    position?: Position;
    range?: Range;
    text?: string;
    options?: { overwrite?: boolean; ignoreIfExists?: boolean };
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

    createFile(uri: unknown, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
        this.operations.push({ kind: "createFile", uri, options });
    }

    /**
     * Real VS Code stores TextEdits whichever method built them, so each one is
     * recorded as the operation it is equivalent to - which keeps a set() and
     * the insert()/delete() calls it replaces indistinguishable to a test, as
     * they are to the editor. set() also *replaces* whatever was recorded for
     * that uri rather than adding to it, so an empty array clears it.
     */
    set(uri: unknown, edits: TextEdit[]): void {
        const remaining = this.operations.filter((operation) => String(operation.uri) !== String(uri));
        this.operations.length = 0;
        this.operations.push(...remaining);

        for (const edit of edits) {
            if (edit.newText.length === 0) {
                this.delete(uri, edit.range);
            } else if (edit.range.isEmpty) {
                this.insert(uri, edit.range.start, edit.newText);
            } else {
                this.replace(uri, edit.range, edit.newText);
            }
        }
    }

    /**
     * The text edits recorded here, grouped by uri as real VS Code returns
     * them: an insert is a TextEdit over the empty range at its position, and a
     * delete one with no text, which is how the editor stores both. A createFile
     * is not a text edit and does not appear.
     */
    entries(): [unknown, TextEdit[]][] {
        const byUri = new Map<string, { uri: unknown; edits: TextEdit[] }>();

        for (const operation of this.operations) {
            const textEdit = WorkspaceEdit.asTextEdit(operation);
            if (!textEdit) {
                continue;
            }

            const key = String(operation.uri);
            const entry = byUri.get(key) ?? { uri: operation.uri, edits: [] };
            entry.edits.push(textEdit);
            byUri.set(key, entry);
        }

        return [...byUri.values()].map(({ uri, edits }) => [uri, edits]);
    }

    private static asTextEdit(operation: RecordedEditOperation): TextEdit | null {
        switch (operation.kind) {
            case "insert":
                return new TextEdit(new Range(operation.position!, operation.position!), operation.text!);
            case "delete":
                return new TextEdit(operation.range!, "");
            case "replace":
                return new TextEdit(operation.range!, operation.text!);
            default:
                return null;
        }
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
    onWillSaveTextDocument: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
    applyEdit: jest.fn().mockResolvedValue(true),
    workspaceFolders: undefined as { uri: { fsPath: string }; name: string; index: number }[] | undefined,
    // Set when a .code-workspace file is open, folder-only workspaces leave it
    // undefined - which is how the environment snapshot tells the two apart.
    workspaceFile: undefined as { fsPath: string } | undefined,
    findFiles: jest.fn().mockResolvedValue([]),
    /**
     * The workspace folder a URI sits in, matched on path prefix. Undefined for
     * a path under no folder, which is what production code reads as a file
     * outside the project - so a test wanting a folder must register it in
     * workspaceFolders rather than rely on a fallback.
     *
     * The first containing folder wins, where real VS Code returns the
     * innermost, and a URI equal to a folder root answers undefined rather than
     * that folder. A test covering the multi-root UEFN workspace, or nested
     * folders, needs more than this.
     */
    getWorkspaceFolder: jest.fn().mockImplementation((target: { fsPath: string }) => {
        const normalized = target.fsPath.replace(/\\/g, "/");
        return workspace.workspaceFolders?.find((folder) => normalized.startsWith(`${folder.uri.fsPath.replace(/\\/g, "/").replace(/\/+$/, "")}/`));
    }),
    // Rejecting is the "no such file" answer, which is what production code
    // reads a missing file as. A resolving default would make an absent
    // definitions file look like an empty existing one.
    fs: {
        readFile: jest.fn().mockRejectedValue(new Error("ENOENT")),
        stat: jest.fn().mockRejectedValue(new Error("ENOENT")),
        writeFile: jest.fn().mockResolvedValue(undefined),
    },
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

const FileType = {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64,
};

/**
 * A code action kind, as vscode.CodeActionKind models one: a dotted string
 * that append() extends. Only the value matters to the providers; nothing
 * dispatches on identity, so plain string comparison is enough.
 */
class CodeActionKind {
    static readonly QuickFix = new CodeActionKind("quickfix");
    static readonly Source = new CodeActionKind("source");
    // Built by append, as the real API builds it, so a provider that appends
    // the wrong sub-kind cannot agree with a mock that hardcoded the answer.
    static readonly SourceOrganizeImports = CodeActionKind.Source.append("organizeImports");

    constructor(public readonly value: string) {}

    append(parts: string): CodeActionKind {
        return new CodeActionKind(`${this.value}.${parts}`);
    }
}

class CodeAction {
    isPreferred?: boolean;
    diagnostics?: unknown[];
    command?: Command;
    edit?: WorkspaceEdit;

    constructor(
        public title: string,
        public kind?: CodeActionKind,
    ) {}
}

/**
 * The host version, as vscode.version reports it. A fixed value: tests assert
 * that it reaches the log, never what it happens to be.
 */
const version = "1.85.0";

export {
    version,
    workspace,
    window,
    languages,
    commands,
    DiagnosticSeverity,
    StatusBarAlignment,
    ConfigurationTarget,
    ProgressLocation,
    EndOfLine,
    FileType,
    Position,
    Range,
    TextEdit,
    WorkspaceEdit,
    Uri,
    RelativePattern,
    Disposable,
    FileSystemWatcher,
    CodeLens,
    CodeAction,
    CodeActionKind,
    EventEmitter,
};

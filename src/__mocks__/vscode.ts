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

class Uri {
    private constructor(public readonly fsPath: string) {}

    static file(fsPath: string): Uri {
        return new Uri(fsPath);
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
    onDidChangeConfiguration: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    applyEdit: jest.fn().mockResolvedValue(true),
    workspaceFolders: undefined as { uri: { fsPath: string }; name: string; index: number }[] | undefined,
    findFiles: jest.fn().mockResolvedValue([]),
    createFileSystemWatcher: jest.fn().mockImplementation((globPattern: unknown) => new FileSystemWatcher(globPattern)),
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
    setStatusBarMessage: jest.fn(),
};

const languages = {
    getDiagnostics: jest.fn().mockReturnValue([]),
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

export { workspace, window, languages, DiagnosticSeverity, StatusBarAlignment, ConfigurationTarget, EndOfLine, Position, Range, WorkspaceEdit, Uri, RelativePattern, Disposable, FileSystemWatcher };

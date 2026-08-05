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

/** Matches vscode.RelativePattern closely enough for findFiles stubs. */
class RelativePattern {
    constructor(
        public readonly base: unknown,
        public readonly pattern: string,
    ) {}
}

/** Minimal stand-in for vscode.Disposable, including the static combinator. */
class Disposable {
    constructor(private readonly callOnDispose: () => void) {}

    static from(...disposables: { dispose: () => unknown }[]): Disposable {
        return new Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
    }

    dispose(): void {
        this.callOnDispose();
    }
}

/** Fresh watcher stub; each event is a jest.fn so tests can capture handlers. */
const createFileSystemWatcherStub = () => ({
    onDidChange: jest.fn(),
    onDidCreate: jest.fn(),
    onDidDelete: jest.fn(),
    dispose: jest.fn(),
});

const workspace = {
    getConfiguration: jest.fn().mockReturnValue({
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn().mockResolvedValue(undefined),
    }),
    onDidChangeConfiguration: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    applyEdit: jest.fn().mockResolvedValue(true),
    workspaceFolders: undefined as { uri: { fsPath: string }; name: string; index: number }[] | undefined,
    findFiles: jest.fn().mockResolvedValue([]),
    createFileSystemWatcher: jest.fn().mockImplementation(() => createFileSystemWatcherStub()),
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

export { workspace, window, languages, DiagnosticSeverity, StatusBarAlignment, ConfigurationTarget, EndOfLine, Position, Range, WorkspaceEdit, RelativePattern, Disposable };

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

const workspace = {
    getConfiguration: jest.fn().mockReturnValue({
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn().mockResolvedValue(undefined),
    }),
    onDidChangeConfiguration: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    applyEdit: jest.fn().mockResolvedValue(true),
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

export { workspace, window, DiagnosticSeverity, StatusBarAlignment, ConfigurationTarget, EndOfLine, Position, Range, WorkspaceEdit };

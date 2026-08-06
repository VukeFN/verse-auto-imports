import { detectEol, ImportDocumentEditor } from "../ImportDocumentEditor";
import { ImportFormatter } from "../ImportFormatter";
import * as vscode from "vscode";

describe("detectEol", () => {
    it("returns null for a text with no line break", () => {
        expect(detectEol("code()")).toBeNull();
    });

    it("detects LF", () => {
        expect(detectEol("a\nb\n")).toBe("\n");
    });

    it("detects CRLF", () => {
        expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    });

    it("takes the dominant ending in a mixed text", () => {
        expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
        expect(detectEol("a\nb\nc\r\n")).toBe("\n");
    });

    it("prefers LF on a tie", () => {
        expect(detectEol("a\r\nb\n")).toBe("\n");
    });
});

describe("ImportDocumentEditor.buildOrganizedContent", () => {
    let editor: ImportDocumentEditor;

    const curlyNoSort = {
        preferDotSyntax: false,
        sortAlphabetically: false,
        importGrouping: "none",
    };
    const curlySorted = { ...curlyNoSort, sortAlphabetically: true };

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
    });

    it("returns null when there are no imports and nothing to add", () => {
        expect(editor.buildOrganizedContent("foo := 1\nbar := 2", [], curlyNoSort)).toBeNull();
    });

    it("consolidates existing imports at the top with one blank line before code", () => {
        const input = "using { /A }\nusing { /B }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\nusing { /B }\n\ncode()");
    });

    it("deduplicates repeated imports", () => {
        const input = "using { /A }\nusing { /A }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("sorts alphabetically when enabled", () => {
        const input = "using { /Zebra }\nusing { /Apple }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /Apple }\nusing { /Zebra }\n\ncode()");
    });

    it("preserves original order when sorting is disabled", () => {
        const input = "using { /Zebra }\nusing { /Apple }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /Zebra }\nusing { /Apple }\n\ncode()");
    });

    it("leaves a commented-out import in the body instead of resurrecting it", () => {
        const input = "<#\nusing { /Old/Path }\n#>\nusing { /Verse.org/Simulation }\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /Verse.org/Simulation }\n\n<#\nusing { /Old/Path }\n#>\n\ncode()");
    });

    it("returns null when the only import in the text is inside a block comment", () => {
        expect(editor.buildOrganizedContent("<#\nusing { /Old/Path }\n#>\n\ncode()", [], curlyNoSort)).toBeNull();
    });

    it("writes the preferred dot syntax", () => {
        const input = "using { /A }\ncode()";
        expect(
            editor.buildOrganizedContent(input, [], {
                ...curlyNoSort,
                preferDotSyntax: true,
            }),
        ).toBe("using. /A\n\ncode()");
    });

    it("normalizes the indented using: pair into a single-line import", () => {
        const input = "using:\n    /A\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("hoists an import scattered below code up into the block", () => {
        const input = "code_before()\nusing { /A }\ncode_after()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode_before()\ncode_after()");
    });

    it("merges additional paths with existing imports, deduped and sorted", () => {
        const input = "using { /Existing }\ncode()";
        expect(editor.buildOrganizedContent(input, ["/Added", "/Existing"], curlySorted)).toBe("using { /Added }\nusing { /Existing }\n\ncode()");
    });

    it("adds imports to a document that had none", () => {
        expect(editor.buildOrganizedContent("code()", ["/New"], curlyNoSort)).toBe("using { /New }\n\ncode()");
    });

    it("hoists a bare column-0 using into the block as a module import", () => {
        // A bare `using { X }` at column 0 can only be a module import (see
        // ImportScanner's header comment), so it is collected like any other
        // import rather than left in the body.
        const input = "using { /A }\nusing { Features }\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\nusing { Features }\n\ncode()");
    });

    it("leaves a function-body local-scope using statement in the body", () => {
        const input = ["using { /A }", "F():void =", "    using { LocalVar }", "    code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe(["using { /A }", "", "F():void =", "    using { LocalVar }", "    code()"].join("\n"));
    });

    it("collapses extra blank lines left by removed top imports", () => {
        const input = "using { /A }\n\n\ncode()";
        expect(editor.buildOrganizedContent(input, [], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("returns only the import block when the file is nothing but imports", () => {
        const input = "using { /B }\nusing { /A }";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /A }\nusing { /B }\n");
    });

    it("ignores blank additional paths", () => {
        const input = "using { /A }\ncode()";
        expect(editor.buildOrganizedContent(input, ["", "   "], curlyNoSort)).toBe("using { /A }\n\ncode()");
    });

    it("orders bare folder imports in input order before dotted references, never alphabetized", () => {
        const input = ["using { Economy.Shop }", "using { Zeta }", "using { Alpha }", "code()"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(["using { Zeta }", "using { Alpha }", "using { Economy.Shop }", "", "code()"].join("\n"));
    });

    it("leaves a module-scoped using inside its module body", () => {
        const input = ["using { /Top }", "", "Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"].join("\n");
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(
            ["using { /Top }", "", "Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"].join("\n"),
        );
    });

    // A CRLF document must come back CRLF throughout: joining with LF left the
    // body lines carrying their original "\r" and produced a mixed buffer.
    it("keeps CRLF endings when reorganizing a CRLF document", () => {
        const input = "using { /B }\r\nusing { /A }\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe("using { /A }\r\nusing { /B }\r\n\r\ncode()\r\n");
    });

    it("reproduces an already organized CRLF document exactly, so organize can skip the edit", () => {
        const input = "using { /A }\r\n\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, [], curlySorted)).toBe(input);
    });

    it("keeps CRLF endings when adding a path to a CRLF document", () => {
        const input = "using { /Existing }\r\ncode()\r\n";
        expect(editor.buildOrganizedContent(input, ["/Added"], curlySorted)).toBe("using { /Added }\r\nusing { /Existing }\r\n\r\ncode()\r\n");
    });

    it("keeps CRLF endings for a CRLF file that is nothing but imports", () => {
        expect(editor.buildOrganizedContent("using { /B }\r\nusing { /A }", [], curlySorted)).toBe("using { /A }\r\nusing { /B }\r\n");
    });

    it("uses the fallback ending when the text has no line break to detect one from", () => {
        expect(editor.buildOrganizedContent("code()", ["/New"], { ...curlyNoSort, fallbackEol: "\r\n" })).toBe("using { /New }\r\n\r\ncode()");
    });

    it("still writes LF for an LF document even when the fallback is CRLF", () => {
        expect(editor.buildOrganizedContent("using { /A }\ncode()", [], { ...curlyNoSort, fallbackEol: "\r\n" })).toBe("using { /A }\n\ncode()");
    });
});

interface RecordedOperation {
    kind: "insert" | "delete" | "replace";
    position?: { line: number; character: number };
    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    text?: string;
}

function fakeDocument(text: string, eol: number = vscode.EndOfLine.LF): vscode.TextDocument {
    const lines = text.split(/\r?\n/);
    return {
        uri: { toString: () => "file:///test.verse" },
        getText: () => text,
        eol,
        lineCount: lines.length,
        lineAt: (index: number) => ({ range: { end: new vscode.Position(index, lines[index].length) } }),
    } as unknown as vscode.TextDocument;
}

function appliedOperations(call: number): RecordedOperation[] {
    const applyEditMock = vscode.workspace.applyEdit as unknown as jest.Mock;
    const edit = applyEditMock.mock.calls[call][0] as { operations: RecordedOperation[] };
    return edit.operations;
}

describe("ImportDocumentEditor.addImportsToDocument", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        applyEditMock().mockClear();
    });

    it("consolidates an indented-style pair without losing its path or orphaning its line", async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key === "behavior.preserveImportLocations") {
                    return false;
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
        const input = ["using:", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.text).toContain("/Verse.org/Simulation");
        expect(insert!.text).toContain("/Fortnite.com/Devices");

        const deletes = operations.filter((op) => op.kind === "delete");
        expect(deletes).toHaveLength(1);
        expect(deletes[0].range!.start.line).toBe(0);
        expect(deletes[0].range!.end.line).toBe(2);
    });

    it("recognizes an import that already exists as an indented pair and makes no edit", async () => {
        const input = ["using:", "    /Verse.org/Simulation", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Verse.org/Simulation }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("adds an import that exists only inside a block comment, above the comment", async () => {
        const input = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "my_device := class(creative_device):", "    Button : button_device = button_device{}"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("insert");
        expect(operations[0].position).toEqual({ line: 0, character: 0 });
        expect(operations[0].text).toBe("using { /Fortnite.com/Devices }\n\n");
    });

    it("dedupes a bare folder import that already exists at column 0 and makes no edit", async () => {
        const input = ["using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("leaves a module-scoped using inside its module body during consolidation", async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key === "behavior.preserveImportLocations") {
                    return false;
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
        const input = ["using { /Top }", "", "Utilities := module:", "    using { /Verse.org/Random }", "", "    GenerateId<public>():int = 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert!.text).not.toContain("/Verse.org/Random");

        const deletes = operations.filter((op) => op.kind === "delete");
        expect(deletes).toHaveLength(1);
        expect(deletes[0].range!.start.line).toBe(0);
        expect(deletes[0].range!.end.line).toBe(1);
    });

    function mockConfig(overrides: Record<string, unknown>): void {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key in overrides) {
                    return overrides[key];
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
        });
    }

    it("preserve + digestFirst: replaces a single import block below a header in place, not at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "using { /Fortnite.com/Devices }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.range!.start.line).toBe(3);
        expect(replace!.text).toContain("/Fortnite.com/Random");
        expect(replace!.text).toContain("/Verse.org/Simulation");
        expect(replace!.text).toContain("/Fortnite.com/Devices");

        // Nothing is inserted above the header comment.
        const insertsAtTop = operations.filter((op) => op.kind === "insert" && op.position!.line === 0);
        expect(insertsAtTop).toHaveLength(0);
    });

    it("preserve + localFirst: replaces a single import block below a header in place, not at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "localFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "using { /Fortnite.com/Devices }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.range!.start.line).toBe(3);
        expect(replace!.text).toContain("/Fortnite.com/Random");
        expect(replace!.text).toContain("/Verse.org/Simulation");

        const insertsAtTop = operations.filter((op) => op.kind === "insert" && op.position!.line === 0);
        expect(insertsAtTop).toHaveLength(0);
    });

    it("preserve + digestFirst: a new bare local import is ordered before an existing dotted local import in its block (rank sort, not alphabetical)", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const header = ["# Header comment line 1", "# Header comment line 2", ""];
        const input = [...header, "using { /Verse.org/Simulation }", "", "using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.text).toBe("using { Features }\nusing { Economy.Shop }\n");
    });

    it("preserve + grouping none + sort on (default config): merges a new bare provider into the existing block in rank order", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const replace = operations.find((op) => op.kind === "replace");
        expect(replace).toBeDefined();
        expect(replace!.range!.start.line).toBe(0);
        expect(replace!.text).toBe("using { Features }\nusing { Economy.Shop }\n");

        // The new import is not appended after the block.
        const insertsAfterBlock = operations.filter((op) => op.kind === "insert" && op.position!.line === 1);
        expect(insertsAfterBlock).toHaveLength(0);
    });

    it("preserve + grouping none + sort OFF: keeps the original append-after-block behavior and leaves existing lines untouched", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["using { Economy.Shop }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        // No block is rewritten; the existing import line stays as-is.
        expect(operations.some((op) => op.kind === "replace")).toBe(false);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(1);
        expect(insert!.text).toBe("using { Features }\n");
    });

    // A blank line between imports starts a second block, and rank-sorting only
    // the first block ordered a new import against that block alone - which put
    // a dotted consumer above the bare provider it needs in the block below.
    it("preserve + grouping none + sort on: a new dotted consumer joins the block holding its bare provider, not the first block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

        expect(success).toBe(true);
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(1);
        expect(replaces[0].range!.start.line).toBe(2);
        expect(replaces[0].text).toBe("using { Features }\nusing { Economy.Shop }\n");
    });

    it("preserve + grouping none + sort on: a new bare provider joins the earlier block holding the dotted consumer it provides for", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { Economy.Shop }", "", "using { /Verse.org/Simulation }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Features }"]);

        expect(success).toBe(true);
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(1);
        expect(replaces[0].range!.start.line).toBe(0);
        expect(replaces[0].text).toBe("using { Features }\nusing { Economy.Shop }\n");
    });

    it("preserve + grouping none + sort on: a new absolute import still joins the first block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { /Fortnite.com/Devices }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(1);
        expect(replaces[0].range!.start.line).toBe(0);
        expect(replaces[0].text).toBe("using { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n");
    });

    it("preserve + grouping none + sort on: imports whose ranks want different blocks are merged into each block separately", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }", "using { Economy.Shop }"]);

        expect(success).toBe(true);
        const replaces = appliedOperations(0).filter((op) => op.kind === "replace");
        expect(replaces).toHaveLength(2);

        // The absolute path joins the block of absolute paths, the dotted
        // reference the block holding its provider.
        expect(replaces[0].range!.start.line).toBe(0);
        expect(replaces[0].text).toBe("using { /Fortnite.com/Random }\nusing { /Verse.org/Simulation }\n");
        expect(replaces[1].range!.start.line).toBe(2);
        expect(replaces[1].text).toBe("using { Features }\nusing { Economy.Shop }\n");

        // Blocks are disjoint, so the two replacements cannot overlap.
        expect(replaces[0].range!.end.line).toBeLessThanOrEqual(replaces[1].range!.start.line);
    });

    it("preserve + grouping none + sort OFF: appends after the last import block, not the first", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": false,
        });
        const input = ["using { /Verse.org/Simulation }", "", "using { Features }", "", "hello := 1"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { Economy.Shop }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations.some((op) => op.kind === "replace")).toBe(false);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(3);
        expect(insert!.text).toBe("using { Economy.Shop }\n");
    });

    it("writes CRLF endings into a CRLF document when merging into an existing block", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "none",
            "behavior.sortImportsAlphabetically": true,
        });
        const input = "using { Economy.Shop }\r\n\r\nhello := 1\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { Features }"]);

        expect(success).toBe(true);
        const replace = appliedOperations(0).find((op) => op.kind === "replace");
        expect(replace!.text).toBe("using { Features }\r\nusing { Economy.Shop }\r\n");
    });

    it("writes CRLF endings into a CRLF document when inserting a new block at the top", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const input = "hello := 1\r\nworld := 2\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert!.text).toBe("using { /Fortnite.com/Random }\r\n\r\n");
    });

    it("writes CRLF endings into a CRLF document when consolidating at the top", async () => {
        mockConfig({ "behavior.preserveImportLocations": false });
        const input = "using { /Verse.org/Simulation }\r\n\r\nhello := 1\r\n";

        const success = await editor.addImportsToDocument(fakeDocument(input, vscode.EndOfLine.CRLF), ["using { /Fortnite.com/Devices }"]);

        expect(success).toBe(true);
        const insert = appliedOperations(0).find((op) => op.kind === "insert");
        expect(insert!.text).toBe("using { /Fortnite.com/Devices }\r\nusing { /Verse.org/Simulation }\r\n");
    });

    it("preserve + digestFirst: inserts at the top when the file has no existing imports", async () => {
        mockConfig({
            "behavior.preserveImportLocations": true,
            "behavior.importGrouping": "digestFirst",
        });
        const input = ["hello := 1", "world := 2"].join("\n");

        const success = await editor.addImportsToDocument(fakeDocument(input), ["using { /Fortnite.com/Random }"]);

        expect(success).toBe(true);
        const operations = appliedOperations(0);

        const insert = operations.find((op) => op.kind === "insert");
        expect(insert).toBeDefined();
        expect(insert!.position!.line).toBe(0);
        expect(insert!.text).toContain("/Fortnite.com/Random");

        expect(operations.some((op) => op.kind === "replace")).toBe(false);
        expect(operations.some((op) => op.kind === "delete")).toBe(false);
    });
});

describe("ImportDocumentEditor.ensureEmptyLinesAfterImports", () => {
    let editor: ImportDocumentEditor;
    const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

    beforeEach(() => {
        const outputChannel = vscode.window.createOutputChannel("test");
        editor = new ImportDocumentEditor(outputChannel, new ImportFormatter());
        applyEditMock().mockClear();
    });

    it("does not enforce spacing after a module-scoped using", async () => {
        const input = ["using { /Top }", "", "M := module:", "    using { /Verse.org/Random }", "    F():void = {}", ""].join("\n");

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input));

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("does not enforce spacing after an import inside a block comment", async () => {
        const input = ["<#", "using { /Fortnite.com/Devices }", "#>", "", "code()"].join("\n");

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input));

        expect(success).toBe(true);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("still enforces spacing after the file-level import block", async () => {
        const input = ["using { /Top }", "code()"].join("\n");

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input));

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("insert");
        expect(operations[0].position!.line).toBe(1);
    });

    // This runs right after both writers, so an LF blank line here would put
    // back the mixed endings they now avoid.
    it("inserts a CRLF blank line in a CRLF document", async () => {
        const input = "using { /Top }\r\ncode()\r\n";

        const success = await editor.ensureEmptyLinesAfterImports(fakeDocument(input, vscode.EndOfLine.CRLF));

        expect(success).toBe(true);
        const operations = appliedOperations(0);
        expect(operations[0].text).toBe("\r\n");
    });
});

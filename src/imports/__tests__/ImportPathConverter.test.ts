import * as vscode from "vscode";
import { ImportPathConverter } from "../ImportPathConverter";

describe("ImportPathConverter.buildFullVersePath", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";

    it("places a Content-root module directly under the project verse path", () => {
        expect(ImportPathConverter.buildFullVersePath(projectVersePath, "", "Inventory")).toBe("/mygame@fortnite.com/mygame/Inventory");
    });

    it('treats a bare "/" location the same as the Content root', () => {
        expect(ImportPathConverter.buildFullVersePath(projectVersePath, "/", "Inventory")).toBe("/mygame@fortnite.com/mygame/Inventory");
    });

    it("inserts a subdirectory location between project path and module", () => {
        expect(ImportPathConverter.buildFullVersePath(projectVersePath, "/Systems", "Inventory")).toBe("/mygame@fortnite.com/mygame/Systems/Inventory");
    });

    it("supports nested locations and multi-segment module paths", () => {
        expect(ImportPathConverter.buildFullVersePath(projectVersePath, "/UI/Shared", "HUD/Textures")).toBe("/mygame@fortnite.com/mygame/UI/Shared/HUD/Textures");
    });
});

describe("ImportPathConverter.buildModuleDefinitionRegex", () => {
    it("matches a module declaration with and without a visibility specifier", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");
        expect(re.test("Inventory := module:")).toBe(true);
        expect(re.test("Inventory<public> := module:")).toBe(true);
        expect(re.test("Inventory := module>")).toBe(true);
    });

    it("matches the brace form, with the brace on the declaration line or the next", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");
        expect(re.test("Inventory := module{}")).toBe(true);
        expect(re.test("Inventory<public> := module { }")).toBe(true);
        expect(re.test("Inventory := module\n{\n    Count<public>:int = 0\n}")).toBe(true);
    });

    it("matches the dotted form, for either name declared on the line", () => {
        const source = "Inventory := module. Item := module{}";

        expect(ImportPathConverter.buildModuleDefinitionRegex("Inventory").test(source)).toBe(true);
        expect(ImportPathConverter.buildModuleDefinitionRegex("Item").test(source)).toBe(true);
    });

    it("matches any specifier the language allows, not a fixed keyword list", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");

        // A scope list holds module references, so the specifier does not end
        // at the keyword.
        expect(re.test("Inventory<scoped{ModuleA, ModuleB}> := module:")).toBe(true);
        expect(re.test("Inventory<epic_internal> := module:")).toBe(true);

        // A named scope is an arbitrary identifier, qualified or not, which no
        // keyword list could cover.
        expect(re.test("Inventory<scoped_X> := module:")).toBe(true);
        expect(re.test("Inventory<Systems.scoped_to_A> := module:")).toBe(true);
    });

    it("matches a stacked specifier block, not one specifier", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");
        expect(re.test("Inventory<internal><final> := module:")).toBe(true);
        expect(re.test("Inventory<public><scoped{ModuleA}> := module { }")).toBe(true);
    });

    it("does not let a stray < reach the specifier of a later declaration", () => {
        // The whole file is tested unmasked, so a `<` that opens nothing - a
        // comparison, or one written in a comment - sits between the name and
        // the next declaration's specifier. A specifier body that could span
        // that far would report this file as declaring Inventory.
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");

        expect(re.test("if (Inventory < MaxSlots):\n\nHelpers<public> := module:")).toBe(false);
        expect(re.test("# Inventory <-- rename before ship\nHelpers<internal> := module:")).toBe(false);
        expect(re.test("Count := Inventory < 3\nOther<final><public> := module {}")).toBe(false);
    });

    it("does not match a different module or a non-module declaration", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");
        expect(re.test("MyInventory := module:")).toBe(false);
        expect(re.test("Inventory := class:")).toBe(false);
        expect(re.test("InventoryItem := module:")).toBe(false);

        // A specifier block is not what makes a declaration a module, so one
        // must not carry a non-module declaration into a match.
        expect(re.test("Inventory<public> := class:")).toBe(false);

        // What follows `module` is a character class, so a keyword that merely
        // starts with it is not a declaration. Written as a bare `.` instead,
        // the dotted style would accept any character and match this.
        expect(re.test("Inventory := modulex")).toBe(false);
    });

    it("is not global, so repeated .test() calls are order-independent", () => {
        // A global regex would retain lastIndex between calls and could skip a
        // match in a later string depending on where the previous match ended.
        const re = ImportPathConverter.buildModuleDefinitionRegex("Foo");
        expect(re.flags).not.toContain("g");

        const withLateMatch = "some preamble text here\n\n\nFoo := module:";
        const withEarlyMatch = "Foo := module:";

        // Call against a string whose match is far into the text, then against a
        // string whose match is at the very start. Both must return true.
        expect(re.test(withLateMatch)).toBe(true);
        expect(re.test(withEarlyMatch)).toBe(true);
        expect(re.test(withLateMatch)).toBe(true);
    });

    it("escapes regex metacharacters in the module name", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("a.b");
        expect(re.test("a.b := module:")).toBe(true);
        expect(re.test("axb := module:")).toBe(false);
    });
});

interface RecordedOperation {
    kind: "insert" | "delete" | "replace";
    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    text?: string;
}

function fakeDocument(lines: string[], eol: "\n" | "\r\n" = "\n"): vscode.TextDocument {
    const text = lines.join(eol);
    return {
        uri: vscode.Uri.file("C:/project/test.verse"),
        getText: () => text,
    } as unknown as vscode.TextDocument;
}

const applyEditMock = () => vscode.workspace.applyEdit as unknown as jest.Mock;

const replacedOperation = (): RecordedOperation => {
    const edit = applyEditMock().mock.calls[0][0] as { operations: RecordedOperation[] };
    return edit.operations[0];
};

describe("ImportPathConverter.applyConversion", () => {
    let converter: ImportPathConverter;

    /** A resolved relative-to-absolute conversion of `using { Gadgets.Tools }`. */
    const conversion = (line?: number) => ({
        originalImport: "using { Gadgets.Tools }",
        fullPathImport: "using { /mygame@fortnite.com/mygame/Gadgets/Tools }",
        moduleName: "Tools",
        isAmbiguous: false,
        line,
    });

    beforeEach(() => {
        converter = new ImportPathConverter(vscode.window.createOutputChannel("test"));
        applyEditMock().mockClear();
    });

    it("edits the line the conversion names, not an identical statement commented out above it", async () => {
        // The commented copy carries no CodeLens after the scanner change, but a
        // search from the top of the document still reaches it first.
        const document = fakeDocument(["<#", "using { Gadgets.Tools }", "#>", "", "using { Gadgets.Tools }", "", "code()"]);

        expect(await converter.applyConversion(document, conversion(4))).toBe(true);

        const replaced = replacedOperation();
        expect(replaced.kind).toBe("replace");
        expect(replaced.range!.start.line).toBe(4);
        expect(replaced.range!.end.line).toBe(4);
        expect(replaced.text).toBe("using { /mygame@fortnite.com/mygame/Gadgets/Tools }");
    });

    it("edits the named one of two identical imports rather than the first", async () => {
        const document = fakeDocument(["using { Gadgets.Tools }", "using { Gadgets.Tools }", "", "code()"]);

        expect(await converter.applyConversion(document, conversion(1))).toBe(true);

        expect(replacedOperation().range!.start.line).toBe(1);
    });

    it("keeps the indentation of the line it edits", async () => {
        // The named line wins on trimmed text, so it survives the user indenting
        // the import while the conversion resolves - and the rewrite has to keep
        // that indent rather than flatten the line.
        const document = fakeDocument(["    using { Gadgets.Tools }", "", "code()"]);

        expect(await converter.applyConversion(document, conversion(0))).toBe(true);

        expect(replacedOperation().text).toBe("    using { /mygame@fortnite.com/mygame/Gadgets/Tools }");
    });

    it("falls back to the first convertible import when the conversion names no line", async () => {
        const document = fakeDocument(["", "using { Gadgets.Tools }", "", "code()"]);

        expect(await converter.applyConversion(document, conversion())).toBe(true);

        expect(replacedOperation().range!.start.line).toBe(1);
    });

    it("falls back to the first convertible import when the named line no longer holds the statement", async () => {
        // The document changed while the conversion was being resolved.
        const document = fakeDocument(["using { Gadgets.Tools }", "", "code()"]);

        expect(await converter.applyConversion(document, conversion(7))).toBe(true);

        expect(replacedOperation().range!.start.line).toBe(0);
    });

    it("does not fall back onto a commented-out copy when the named line has moved", async () => {
        // Resolving a conversion spans a workspace scan, and an ambiguous one a
        // quick pick, so the document can change under a recorded line. The
        // fallback must still refuse the lines a lens would never appear on.
        const document = fakeDocument(["<#", "using { Gadgets.Tools }", "#>", "", "code()"]);

        expect(await converter.applyConversion(document, conversion(9))).toBe(false);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("reports failure when the statement is nowhere in the document", async () => {
        const document = fakeDocument(["using { Other.Module }", "", "code()"]);

        expect(await converter.applyConversion(document, conversion(0))).toBe(false);
        expect(applyEditMock()).not.toHaveBeenCalled();
    });

    it("keeps the comment trailing the line it converts", async () => {
        // The replacement is built from the statement alone, so the annotation
        // the author wrote beside the import has to be put back onto it.
        const document = fakeDocument(["using { Gadgets.Tools } # only the tools, not the gadgets", "", "code()"]);
        const annotated = { ...conversion(0), originalImport: "using { Gadgets.Tools } # only the tools, not the gadgets" };

        expect(await converter.applyConversion(document, annotated)).toBe(true);

        expect(replacedOperation().text).toBe("using { /mygame@fortnite.com/mygame/Gadgets/Tools } # only the tools, not the gadgets");
    });

    it("keeps an inline block comment trailing the line it converts", async () => {
        // `<# ... #>` closes on the same line, so it annotates that line only.
        // An opener the line never closes anchors the lines below it instead,
        // and scanConvertibleImports keeps that one away from the converter.
        const document = fakeDocument(["using { Gadgets.Tools } <# tools only #>", "", "code()"]);
        const annotated = { ...conversion(0), originalImport: "using { Gadgets.Tools } <# tools only #>" };

        expect(await converter.applyConversion(document, annotated)).toBe(true);

        expect(replacedOperation().text).toBe("using { /mygame@fortnite.com/mygame/Gadgets/Tools } <# tools only #>");
    });

    it("keeps indentation and a trailing comment together", async () => {
        const document = fakeDocument(["    using { Gadgets.Tools } # kept", "", "code()"]);
        const annotated = { ...conversion(0), originalImport: "using { Gadgets.Tools } # kept" };

        expect(await converter.applyConversion(document, annotated)).toBe(true);

        expect(replacedOperation().text).toBe("    using { /mygame@fortnite.com/mygame/Gadgets/Tools } # kept");
    });

    it("keeps the dotted style when the trailing comment of an ambiguous import contains a brace", async () => {
        // The user picks the path from a quick pick, and the style comes from
        // the statement the pick was offered against. A `{` in the comment is
        // prose, not syntax, so it must not turn a dotted import braced.
        const line = "using. Gadgets.Tools # prefer {Tools} over {Gadgets}";
        const document = fakeDocument([line, "", "code()"]);
        const ambiguous = {
            originalImport: line,
            fullPathImport: "",
            moduleName: "Tools",
            isAmbiguous: true,
            possiblePaths: ["/mygame@fortnite.com/mygame/Gadgets/Tools", "/mygame@fortnite.com/mygame/UI/Gadgets/Tools"],
            line: 0,
        };

        expect(await converter.applyConversion(document, ambiguous, "/mygame@fortnite.com/mygame/Gadgets/Tools")).toBe(true);

        expect(replacedOperation().text).toBe("using. /mygame@fortnite.com/mygame/Gadgets/Tools # prefer {Tools} over {Gadgets}");
    });

    it("does not carry the carriage return of a CRLF line into the comment it restores", async () => {
        // The comment is read back out of the line about to be replaced, so a
        // `\r` left on that line would be written into the middle of the
        // rebuilt one - splitting it where the comment starts.
        const document = fakeDocument(["using { Gadgets.Tools } # kept", "", "code()"], "\r\n");
        const annotated = { ...conversion(0), originalImport: "using { Gadgets.Tools } # kept" };

        expect(await converter.applyConversion(document, annotated)).toBe(true);

        expect(replacedOperation().text).toBe("using { /mygame@fortnite.com/mygame/Gadgets/Tools } # kept");
    });

    it("ends the replace range at the true end of a CRLF line", async () => {
        // The end column comes from the split line's length, so splitting on
        // "\n" makes it one past the end of the line on every CRLF document.
        // Real VS Code clamps the overshoot, which is exactly why nothing here
        // can be left resting on it.
        const document = fakeDocument(["using { Gadgets.Tools }", "", "code()"], "\r\n");

        expect(await converter.applyConversion(document, conversion(0))).toBe(true);

        const range = replacedOperation().range!;
        expect(range.start).toEqual({ line: 0, character: 0 });
        expect(range.end).toEqual({ line: 0, character: "using { Gadgets.Tools }".length });
    });

    it("leaves every other line of a CRLF document byte-identical", async () => {
        const lines = ["using { Gadgets.Tools }", "", "code()"];
        const document = fakeDocument(lines, "\r\n");

        expect(await converter.applyConversion(document, conversion(0))).toBe(true);

        const replaced = replacedOperation();
        expect(applyOperation(document.getText(), replaced, "\r\n")).toBe(["using { /mygame@fortnite.com/mygame/Gadgets/Tools }", "", "code()"].join("\r\n"));
    });
});

/**
 * Applies a recorded replace operation to `text`, resolving its positions the
 * way VS Code does: against lines that exclude the terminator.
 *
 * The mock's Range does not clamp an out-of-range column, which is what lets a
 * test see the range the code actually built rather than the one the host
 * would have salvaged from it.
 */
function applyOperation(text: string, operation: RecordedOperation, eol: "\n" | "\r\n"): string {
    const lines = text.split(eol);
    const offsetOf = (position: { line: number; character: number }) => lines.slice(0, position.line).reduce((total, line) => total + line.length + eol.length, 0) + position.character;

    return text.slice(0, offsetOf(operation.range!.start)) + operation.text + text.slice(offsetOf(operation.range!.end));
}

/** A converter with project path resolution pinned, so conversion is pure string work. */
function converterWithProjectPath(projectVersePath: string): ImportPathConverter {
    const converter = new ImportPathConverter(vscode.window.createOutputChannel("test"));
    (converter as unknown as { projectPathHandler: { getProjectVersePath: () => Promise<string> } }).projectPathHandler.getProjectVersePath = async () => projectVersePath;
    return converter;
}

describe("ImportPathConverter import classification", () => {
    // Both classifiers read the path through extractPathFromImport, where the
    // braced pattern used to be tried first and unanchored - so a comment
    // cross-referencing another import handed them its path instead of the
    // statement's own, and a relative import answered as full-path and built-in.
    it("judges a dotted import on its own path, not on a `using { X }` in its comment", () => {
        const converter = converterWithProjectPath("/mygame@fortnite.com/mygame");
        const statement = "using. Economy.Shop # was using { /Verse.org/Simulation }";

        expect(converter.isFullPathImport(statement)).toBe(false);
        expect(converter.isBuiltinModule(statement)).toBe(false);
        expect(converter.extractModuleFromImport(statement)?.moduleName).toBe("Shop");
    });
});

describe("ImportPathConverter.convertFromFullPath", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";

    beforeEach(() => {
        applyEditMock().mockClear();
    });

    it("leaves the comment trailing a dotted import out of the converted path", async () => {
        // The dotted capture runs to end of line, so reading the path without
        // stripping the comment first builds the comment into the relative
        // import - where applyConversion, which restores it, writes it twice.
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using. /mygame@fortnite.com/mygame/Economy/Shop # only the shop, not the vendor", 0);

        expect(result?.fullPathImport).toBe("using. Economy.Shop");
        expect(result?.moduleName).toBe("Shop");
    });

    it("leaves the comment trailing a braced import out of the converted path", async () => {
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using { /mygame@fortnite.com/mygame/Economy/Shop } # only the shop", 0);

        expect(result?.fullPathImport).toBe("using { Economy.Shop }");
    });

    it("keeps the dotted style when the trailing comment contains a brace", async () => {
        // The style test reads the statement, not the path, so it is the one
        // reader a comment can still reach. A `{` in comment prose is not the
        // author asking for braced syntax.
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using. /mygame@fortnite.com/mygame/Economy/Shop # use {braces} here", 0);

        expect(result?.fullPathImport).toBe("using. Economy.Shop");
    });

    it("keeps the braced style when the trailing comment also contains a brace", async () => {
        // The other half of the same rule: stripping the comment must not cost
        // a braced import its braces, whatever the comment happens to hold.
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using { /mygame@fortnite.com/mygame/Economy/Shop } # see {Vendor}", 0);

        expect(result?.fullPathImport).toBe("using { Economy.Shop }");
    });

    it("writes the comment once, and unaltered, when the conversion is applied", async () => {
        // The two halves have to agree on who owns the comment: the converted
        // statement leaves it out and applyConversion puts it back. The `/` in
        // this comment is what carrying it through the path damaged - the path
        // splits on "/" and rejoins on ".", so it came back as `Economy.Vendor`.
        const line = "using. /mygame@fortnite.com/mygame/Economy/Shop # see Economy/Vendor";
        const document = fakeDocument([line, "", "code()"]);
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath(line, 0);
        expect(await converter.applyConversion(document, result!)).toBe(true);

        expect(replacedOperation().text).toBe("using. Economy.Shop # see Economy/Vendor");
    });
});

describe("ImportPathConverter.convertToFullPath", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";

    /** A converter that resolves every module to one fixed location, so conversion is pure string work. */
    function converterWithLocation(location: string): ImportPathConverter {
        const converter = converterWithProjectPath(projectVersePath);
        converter.findModuleLocations = async () => [location];
        return converter;
    }

    it("keeps the dotted style when the trailing comment contains a brace", async () => {
        const converter = converterWithLocation("/Economy");

        const result = await converter.convertToFullPath("using. Shop # use {braces} here", vscode.Uri.file("C:/project/test.verse"), 0);

        expect(result?.fullPathImport).toBe("using. /mygame@fortnite.com/mygame/Economy/Shop");
    });

    it("keeps the braced style when the trailing comment also contains a brace", async () => {
        const converter = converterWithLocation("/Economy");

        const result = await converter.convertToFullPath("using { Shop } # see {Vendor}", vscode.Uri.file("C:/project/test.verse"), 0);

        expect(result?.fullPathImport).toBe("using { /mygame@fortnite.com/mygame/Economy/Shop }");
    });

    // A brace in comment prose costs the statement its style; a whole
    // `using { X }` in there used to cost it its module, converting the
    // cross-referenced import rather than the one on the line.
    it("converts the module on the line, not one named in its trailing comment", async () => {
        const converter = converterWithLocation("/Economy");

        const result = await converter.convertToFullPath("using. Shop # was using { Inventory }", vscode.Uri.file("C:/project/test.verse"), 0);

        expect(result?.fullPathImport).toBe("using. /mygame@fortnite.com/mygame/Economy/Shop");
        expect(result?.moduleName).toBe("Shop");
    });
});

describe("ImportPathConverter.findModuleLocations explicit declaration scan", () => {
    const workspaceRoot = "C:/Project";
    const declaringFile = `${workspaceRoot}/Content/Systems/Inventory.verse`;

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    /**
     * The locations the scan finds for "Inventory" in a project whose one
     * `.verse` file holds `source`. No current file is passed, so the folder
     * search is skipped and the declaration scan is the only phase that runs.
     */
    async function locationsFor(source: string): Promise<string[]> {
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([vscode.Uri.file(declaringFile)]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(source, "utf8"));

        const converter = new ImportPathConverter(vscode.window.createOutputChannel("test"));
        return converter.findModuleLocations("Inventory");
    }

    beforeEach(() => {
        setWorkspaceFolders([{ uri: { fsPath: workspaceRoot }, name: "Project", index: 0 }]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    it("reports the directory of a live declaration", async () => {
        expect(await locationsFor("Inventory := module:\n    Count<public>:int = 0\n")).toEqual(["/Systems"]);
    });

    // A location the module does not live in is worse than none: it either
    // makes a single, correct conversion ambiguous, or resolves to the wrong
    // file and writes that path into the user's source.
    it("ignores a declaration commented out with a line comment", async () => {
        expect(await locationsFor("# Inventory := module:            # renamed, kept for reference\n")).toEqual([]);
    });

    it("ignores a declaration inside a block comment", async () => {
        expect(await locationsFor("<# Inventory := module:\n   dropped in the 1.4 pass #>\n")).toEqual([]);
    });

    it("ignores a declaration inside an indented comment marker", async () => {
        expect(await locationsFor("<#>\n    Inventory := module:\n        Count<public>:int = 0\n")).toEqual([]);
    });

    it("ignores declaration text quoted in a string literal", async () => {
        expect(await locationsFor('Doc := "Inventory := module:"\n')).toEqual([]);
    });
});

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

    it("does not match a different module or a non-module declaration", () => {
        const re = ImportPathConverter.buildModuleDefinitionRegex("Inventory");
        expect(re.test("MyInventory := module:")).toBe(false);
        expect(re.test("Inventory := class:")).toBe(false);
        expect(re.test("InventoryItem := module:")).toBe(false);
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

function fakeDocument(lines: string[]): vscode.TextDocument {
    const text = lines.join("\n");
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

    it("does not carry the carriage return of a CRLF line into the comment it restores", async () => {
        // The document is split on "\n", so every line of a CRLF file ends in a
        // `\r` and the comment is read out of text carrying one. Writing that
        // `\r` back mid-line would split the line where the comment starts.
        const document = fakeDocument(["using { Gadgets.Tools } # kept\r", "\r", "code()\r"]);
        const annotated = { ...conversion(0), originalImport: "using { Gadgets.Tools } # kept" };

        expect(await converter.applyConversion(document, annotated)).toBe(true);

        expect(replacedOperation().text).toBe("using { /mygame@fortnite.com/mygame/Gadgets/Tools } # kept");
    });
});

/** A converter with project path resolution pinned, so conversion is pure string work. */
function converterWithProjectPath(projectVersePath: string): ImportPathConverter {
    const converter = new ImportPathConverter(vscode.window.createOutputChannel("test"));
    (converter as unknown as { projectPathHandler: { getProjectVersePath: () => Promise<string> } }).projectPathHandler.getProjectVersePath = async () => projectVersePath;
    return converter;
}

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

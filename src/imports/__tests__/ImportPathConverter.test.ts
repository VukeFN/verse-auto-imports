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
        convertedImport: "using { /mygame@fortnite.com/mygame/Gadgets/Tools }",
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
            convertedImport: "",
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

/** workspaceFolders is readonly in the real typings; the mock is writable. */
function setWorkspaceFolders(folders: unknown): void {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
}

/**
 * Answers `fs.stat` from a list of Content-relative directories, so a test can
 * express the project as the tree the module search walks.
 *
 * Case-sensitive, unlike a Windows filesystem, which is what lets a test hold
 * `Shop` and `shop` as two directories: the conversion has to keep them apart
 * because the compiler resolves module names byte-exact, and a stat that folded
 * them would hide the very drift under test.
 */
function stubFolderTree(workspaceRoot: string, folders: string[]): void {
    (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: { fsPath: string }) => {
        const contentRelative = uri.fsPath.replace(/\\/g, "/").replace(`${workspaceRoot}/Content/`, "");
        if (!folders.includes(contentRelative)) throw new Error("ENOENT");
        return { type: vscode.FileType.Directory };
    });
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

    // No caller reaches these readers with a line carrying anything after its
    // statement: scanConvertibleImports feeds them, and it excludes such a line
    // because a rebuild cannot reproduce its span. That filter is written for
    // that reason rather than to keep the path readers honest, so the two are
    // pinned apart - widening what the converter is fed must not silently start
    // converting the leftover.
    it("reads a dotted path as far as the statement ends, not to end of line", () => {
        const converter = converterWithProjectPath("/mygame@fortnite.com/mygame");

        expect(converter.extractModuleFromImport("using. Gadgets.Tools; MyVal := 5")).toEqual({ fullPath: "Gadgets/Tools", moduleName: "Tools" });
    });

    it("names the module of a dotted absolute path without the statement written after it", () => {
        const converter = converterWithProjectPath("/mygame@fortnite.com/mygame");

        expect(converter.extractModuleName("using. /mygame@fortnite.com/mygame/Gadgets/Tools; MyVal := 5")).toBe("Tools");
    });
});

describe("ImportPathConverter.convertFromFullPath", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";
    const workspaceRoot = "C:/Project";

    /**
     * The importing file, at the Content root so the project root is the scope
     * it shortens against - which is what these assertions were written for,
     * back when the conversion took no document at all.
     */
    const documentUri = vscode.Uri.file(`${workspaceRoot}/Content/Feature.verse`);

    beforeEach(() => {
        applyEditMock().mockClear();
        setWorkspaceFolders([{ uri: { fsPath: workspaceRoot }, name: "Project", index: 0 }]);
        stubFolderTree(workspaceRoot, ["Economy", "Economy/Shop"]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    it("leaves the comment trailing a dotted import out of the converted path", async () => {
        // Reading the path without stripping the comment first builds the
        // comment into the relative import - where applyConversion, which
        // restores it, writes it twice.
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using. /mygame@fortnite.com/mygame/Economy/Shop # only the shop, not the vendor", documentUri, 0);

        expect(result?.convertedImport).toBe("using. Economy.Shop");
        expect(result?.moduleName).toBe("Shop");
    });

    it("leaves the comment trailing a braced import out of the converted path", async () => {
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using { /mygame@fortnite.com/mygame/Economy/Shop } # only the shop", documentUri, 0);

        expect(result?.convertedImport).toBe("using { Economy.Shop }");
    });

    it("keeps the dotted style when the trailing comment contains a brace", async () => {
        // The style test reads the statement, not the path, so it is the one
        // reader a comment can still reach. A `{` in comment prose is not the
        // author asking for braced syntax.
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using. /mygame@fortnite.com/mygame/Economy/Shop # use {braces} here", documentUri, 0);

        expect(result?.convertedImport).toBe("using. Economy.Shop");
    });

    it("keeps the braced style when the trailing comment also contains a brace", async () => {
        // The other half of the same rule: stripping the comment must not cost
        // a braced import its braces, whatever the comment happens to hold.
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath("using { /mygame@fortnite.com/mygame/Economy/Shop } # see {Vendor}", documentUri, 0);

        expect(result?.convertedImport).toBe("using { Economy.Shop }");
    });

    it("writes the comment once, and unaltered, when the conversion is applied", async () => {
        // The two halves have to agree on who owns the comment: the converted
        // statement leaves it out and applyConversion puts it back. The `/` in
        // this comment is what carrying it through the path damaged - the path
        // splits on "/" and rejoins on ".", so it came back as `Economy.Vendor`.
        const line = "using. /mygame@fortnite.com/mygame/Economy/Shop # see Economy/Vendor";
        const document = fakeDocument([line, "", "code()"]);
        const converter = converterWithProjectPath(projectVersePath);

        const result = await converter.convertFromFullPath(line, documentUri, 0);
        expect(await converter.applyConversion(document, result!)).toBe(true);

        expect(replacedOperation().text).toBe("using. Economy.Shop # see Economy/Vendor");
    });
});

describe("ImportPathConverter.convertFromFullPath scope-relative shortening", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";
    const workspaceRoot = "C:/Project";

    /**
     * Every folder the project holds, as Content-relative paths.
     *
     * The whole suite runs against a real tree, not only the round trip below
     * it: the conversion resolves the reference it emits back through the
     * module search, so a shortening asserted over an empty workspace would be
     * asserting the refusal rather than the spelling.
     */
    // UI/Shop is a namesake of Systems/Economy/Shop parked off the walk out of
    // Systems/Economy, so the suite also holds the conversion open: only a
    // namesake the compiler would actually reach may refuse one.
    const folders = ["Systems", "Systems/Economy", "Systems/Economy/Shop", "Systems/Inventory", "UI", "UI/HUD", "UI/HUD/Textures", "UI/Shop"];

    /** A file in a module under the project's Content root, which is what places the importing scope. */
    const fileAt = (contentRelativeDir: string): vscode.Uri => vscode.Uri.file(`${workspaceRoot}/Content/${contentRelativeDir}/Feature.verse`);

    /** The statement the converter writes for an absolute path, as seen from `fileUri`. */
    async function relativeFormOf(fullPath: string, fileUri?: vscode.Uri): Promise<string | undefined> {
        const converter = converterWithProjectPath(projectVersePath);
        const result = await converter.convertFromFullPath(`using. ${fullPath}`, fileUri, 0);
        return result?.convertedImport;
    }

    beforeEach(() => {
        setWorkspaceFolders([{ uri: { fsPath: workspaceRoot }, name: "Project", index: 0 }]);
        stubFolderTree(workspaceRoot, folders);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    it("names a module in the importing file's own module by its bare name", async () => {
        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy/Shop`, fileAt("Systems/Economy"))).toBe("using. Shop");
    });

    it("drops only the segments the importing file's module shares", async () => {
        // Inventory sits beside the file's module rather than in it, so the
        // reference resolves through Systems - the nearest scope both share.
        expect(await relativeFormOf(`${projectVersePath}/Systems/Inventory`, fileAt("Systems/Economy"))).toBe("using. Inventory");
    });

    it("keeps every segment below the project when the two branches part at the root", async () => {
        expect(await relativeFormOf(`${projectVersePath}/UI/HUD/Textures`, fileAt("Systems/Economy"))).toBe("using. UI.HUD.Textures");
    });

    it("converts a path whose project prefix differs from the project's only in case", async () => {
        // The prefix test used to be case-sensitive, and a mismatch did not
        // fall back - it skipped the strip, leaving the account segment in the
        // dotted form.
        expect(await relativeFormOf("/MYGAME@FORTNITE.COM/MYGAME/Systems/Economy/Shop", fileAt("Systems/Economy"))).toBe("using. Shop");
    });

    it("ends the shared part at a segment boundary, never inside a segment", async () => {
        // Epic's own converter walks characters and ends the common part
        // mid-label when one path runs out inside the other's segment, which
        // would make this `omy.Shop`.
        //
        // Its own tree: a Content-level Economy beside the suite's
        // Systems/Economy would be a second module of that name on the walk out
        // of Systems/Economy, which the conversion refuses - correctly, and for
        // a reason this test is not about.
        stubFolderTree(workspaceRoot, ["Econ", "Economy", "Economy/Shop"]);

        expect(await relativeFormOf(`${projectVersePath}/Economy/Shop`, fileAt("Econ"))).toBe("using. Economy.Shop");
    });

    it("names the importing file's own module by its own name", async () => {
        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy`, fileAt("Systems/Economy"))).toBe("using. Economy");
    });

    it("names an ancestor whose project prefix differs from the project's only in case", async () => {
        // The ancestor branch has its own test for "is this inside the
        // project", and a case-sensitive one there would refuse exactly the
        // paths the case-insensitive shortening above it accepts.
        expect(await relativeFormOf("/MYGAME@FORTNITE.COM/MYGAME/Systems", fileAt("Systems/Economy"))).toBe("using. Systems");
    });

    it("offers no conversion for the project root itself", async () => {
        // The one target with nothing nameable above it: what encloses the
        // project root is the registry, not a scope the file sits in.
        const converter = converterWithProjectPath(projectVersePath);

        expect(await converter.convertFromFullPath(`using. ${projectVersePath}`, fileAt("Systems/Economy"), 0)).toBeNull();
    });

    it("places a file the same way when the workspace is opened at Content itself", async () => {
        setWorkspaceFolders([{ uri: { fsPath: `${workspaceRoot}/Content` }, name: "Content", index: 0 }]);

        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy/Shop`, vscode.Uri.file(`${workspaceRoot}/Content/Systems/Economy/Feature.verse`))).toBe("using. Shop");
    });

    it("shortens against the project root for a file at the Content root", async () => {
        // The project root is a scope the file really does sit in, so the
        // reference it produces resolves - unlike the two fallbacks below.
        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy/Shop`, vscode.Uri.file(`${workspaceRoot}/Content/Feature.verse`))).toBe("using. Systems.Economy.Shop");
    });

    // The two below used to shorten against the project root as a fallback. A
    // file the Content root does not hold has no module scope, and a reference
    // written into a scope nothing can name is a guess: neither which module it
    // reaches nor whether it reaches one is answerable. The conversion
    // overwrites an import that compiles, so a guess is the one thing it must
    // not write.
    it("offers no conversion for a file outside Content", async () => {
        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy/Shop`, vscode.Uri.file(`${workspaceRoot}/Plugins/Feature.verse`))).toBeUndefined();
    });

    it("offers no conversion when no workspace folder holds the file", async () => {
        // A folder is open, just not one this file sits under - which is what
        // leaves the file unplaceable, rather than the workspace being empty.
        setWorkspaceFolders([{ uri: { fsPath: "C:/Elsewhere" }, name: "Elsewhere", index: 0 }]);

        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy/Shop`, fileAt("Systems/Economy"))).toBeUndefined();
    });

    it("names an ancestor of the importing file's module by its own name", async () => {
        // Nothing is left after the shared part, but the module still has a
        // name, and what encloses it encloses the file too. Returning no
        // conversion here instead took away one the lens used to offer.
        expect(await relativeFormOf(`${projectVersePath}/Systems`, fileAt("Systems/Economy"))).toBe("using. Systems");
    });

    it("keeps the braced style and the trailing comment while shortening", async () => {
        const converter = converterWithProjectPath(projectVersePath);
        const statement = `using { ${projectVersePath}/Systems/Economy/Shop } # only the shop`;

        expect((await converter.convertFromFullPath(statement, fileAt("Systems/Economy"), 0))?.convertedImport).toBe("using { Shop }");
    });

    // The round trip runs the real outward search over a folder tree, not a
    // pinned location: a stub answers with the location the assertion already
    // assumes, so it recomposes the path from its own input and cannot see the
    // reverse direction failing to place a spelling this one writes.
    describe("round trip through the real module search", () => {
        it.each([
            ["a module inside the file's own module", "Systems/Economy/Shop"],
            ["a module beside the file's own module", "Systems/Inventory"],
            ["a module on an unrelated branch", "UI/HUD/Textures"],
            ["the file's own module", "Systems/Economy"],
            ["an ancestor of the file's own module", "Systems"],
        ])("restores the absolute path of %s", async (_name, modulePath) => {
            const converter = converterWithProjectPath(projectVersePath);
            const fileUri = fileAt("Systems/Economy");
            const absolute = `using. ${projectVersePath}/${modulePath}`;

            const relative = await converter.convertFromFullPath(absolute, fileUri, 0);

            expect((await converter.convertToFullPath(relative!.convertedImport, fileUri, 0))?.convertedImport).toBe(absolute);
        });
    });
});

// The relative form is a proposal until the module search confirms it names
// the module the absolute path named. Before that check, going relative was
// string arithmetic that consulted nothing, so every case below wrote a
// compiling import that reached a different module, or none.
describe("ImportPathConverter.convertFromFullPath resolve-back", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";
    const workspaceRoot = "C:/Project";

    const fileAt = (contentRelativeDir: string): vscode.Uri => vscode.Uri.file(`${workspaceRoot}/Content/${contentRelativeDir}/Feature.verse`);

    async function relativeFormOf(fullPath: string, fileUri: vscode.Uri): Promise<string | undefined> {
        const converter = converterWithProjectPath(projectVersePath);
        return (await converter.convertFromFullPath(`using. ${fullPath}`, fileUri, 0))?.convertedImport;
    }

    beforeEach(() => {
        setWorkspaceFolders([{ uri: { fsPath: workspaceRoot }, name: "Project", index: 0 }]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    });

    it("offers no conversion for a file the Content root does not hold, even with the project scanned", async () => {
        // The check cannot speak for a file it cannot place. Only the first
        // phase of the module search walks outward from the document; the
        // phases behind it scan the workspace, and answer the same for any
        // file that asks - so they confirm a reference for a scope nothing
        // here knows, and the conversion writes it.
        //
        // Stubbing findFiles is what makes this test honest. Left at the
        // mock's empty default it passes against the unguarded code too,
        // which is not the case production runs.
        stubFolderTree(workspaceRoot, ["Systems", "Systems/Economy", "Systems/Economy/Shop"]);
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([vscode.Uri.file(`${workspaceRoot}/Content/Systems/Economy/Shop/Item.verse`)]);

        expect(await relativeFormOf(`${projectVersePath}/Systems/Economy/Shop`, vscode.Uri.file(`${workspaceRoot}/Plugins/Feature.verse`))).toBeUndefined();
    });

    it("offers no conversion when a namesake sits between the file and the target", async () => {
        // `using. Weapons` in Content/Systems resolves through Systems first,
        // where a Weapons of its own is waiting. The file still compiles, and
        // imports the other module.
        stubFolderTree(workspaceRoot, ["Weapons", "Systems", "Systems/Weapons"]);

        expect(await relativeFormOf(`${projectVersePath}/Weapons`, fileAt("Systems"))).toBeUndefined();
    });

    it("offers no conversion when a nearer namesake takes the first segment and carries nothing below it", async () => {
        // Systems/UI holds no HUD, so `using. UI.HUD.Textures` resolves UI to
        // the near one and then fails - while the chain it was shortened from
        // exists whole at the Content root. This is why the first segment is
        // what gets resolved: matching UI/HUD/Textures as one path finds the
        // root copy, reports a single location, and confirms a reference the
        // compiler cannot read.
        stubFolderTree(workspaceRoot, ["UI", "UI/HUD", "UI/HUD/Textures", "Systems", "Systems/UI"]);

        expect(await relativeFormOf(`${projectVersePath}/UI/HUD/Textures`, fileAt("Systems"))).toBeUndefined();
    });

    it("keeps a conversion whose only namesake is off the path the compiler walks", async () => {
        // The other half of that rule: a namesake the scope walk never reaches
        // is not a reason to refuse.
        stubFolderTree(workspaceRoot, ["UI", "UI/Weapons", "Systems", "Systems/Weapons"]);

        expect(await relativeFormOf(`${projectVersePath}/Systems/Weapons`, fileAt("Systems"))).toBe("using. Weapons");
    });

    it.each([
        ["a foreign account", "/other@fortnite.com/mygame/Gadgets"],
        ["a sibling project under the same account", "/mygame@fortnite.com/otherproject/Gadgets"],
    ])("offers no conversion for a path outside the project: %s", async (_name, fullPath) => {
        // Shortened by whatever prefix it shared, the foreign account emitted
        // `other@fortnite.com.mygame.Gadgets`, whose first segment cannot lex -
        // `@` is not an identifier character - and the sibling project emitted
        // a reference that resolves nowhere here. Both replaced an import that
        // was already broken with one that no longer converts back.
        stubFolderTree(workspaceRoot, ["Systems", "Gadgets"]);

        expect(await relativeFormOf(fullPath, fileAt("Systems"))).toBeUndefined();
    });

    it("keeps two folder names that differ only in case apart", async () => {
        // The case fold used to run the length of the walk, so `shop` and
        // `Shop` counted as one segment and the reference came out as `Item` -
        // shop's own Item, or nothing. Only the project prefix is folded now,
        // because that is where one package legitimately reaches this code
        // spelled two ways; below it a segment is a module name the compiler
        // resolves byte-exact.
        stubFolderTree(workspaceRoot, ["shop", "Shop", "Shop/Item"]);

        expect(await relativeFormOf(`${projectVersePath}/Shop/Item`, fileAt("shop"))).toBe("using. Shop.Item");
    });
});

describe("ImportPathConverter.convertToFullPath", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";

    /** A converter that resolves every module to one fixed location, so conversion is pure string work. */
    function converterWithLocation(location: string): ImportPathConverter {
        const converter = converterWithProjectPath(projectVersePath);
        converter.findModuleLocations = async () => ({ locations: [location], truncated: false });
        return converter;
    }

    it("keeps the dotted style when the trailing comment contains a brace", async () => {
        const converter = converterWithLocation("/Economy");

        const result = await converter.convertToFullPath("using. Shop # use {braces} here", vscode.Uri.file("C:/project/test.verse"), 0);

        expect(result?.convertedImport).toBe("using. /mygame@fortnite.com/mygame/Economy/Shop");
    });

    it("keeps the braced style when the trailing comment also contains a brace", async () => {
        const converter = converterWithLocation("/Economy");

        const result = await converter.convertToFullPath("using { Shop } # see {Vendor}", vscode.Uri.file("C:/project/test.verse"), 0);

        expect(result?.convertedImport).toBe("using { /mygame@fortnite.com/mygame/Economy/Shop }");
    });

    // A brace in comment prose costs the statement its style; a whole
    // `using { X }` in there used to cost it its module, converting the
    // cross-referenced import rather than the one on the line.
    it("converts the module on the line, not one named in its trailing comment", async () => {
        const converter = converterWithLocation("/Economy");

        const result = await converter.convertToFullPath("using. Shop # was using { Inventory }", vscode.Uri.file("C:/project/test.verse"), 0);

        expect(result?.convertedImport).toBe("using. /mygame@fortnite.com/mygame/Economy/Shop");
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
     * The locations the scan finds for `modulePath` in a project whose one
     * `.verse` file holds `source`. No current file is passed, so the folder
     * search is skipped and the declaration scan is the only phase that runs.
     */
    async function locationsFor(source: string, modulePath = "Inventory"): Promise<string[]> {
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([vscode.Uri.file(declaringFile)]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(source, "utf8"));

        const converter = new ImportPathConverter(vscode.window.createOutputChannel("test"));
        return (await converter.findModuleLocations(modulePath)).locations;
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

    // A `<` that opens nothing - a comparison, say - sits between an ordinary
    // identifier and a later declaration's specifier. A specifier body free to
    // reach that far reads the comparison's left operand as the declared name
    // and swallows the real declaration behind it, so the file answers for a
    // module it does not declare and stops answering for the one it does.
    it("does not read a comparison operand as the declared name", async () => {
        const source = "if (Inventory < MaxSlots):\n    Log()\n\nHelpers<public> := module:\n";

        expect(await locationsFor(source)).toEqual([]);
        expect(await locationsFor(source, "Helpers")).toEqual(["/Systems"]);
    });

    // A module declared inside another is an ordinary path scope, so the inner
    // one is named through the outer. Deciding the location from the directory
    // string alone reported this as missing, and answered the bare inner name
    // with a location that builds a path nothing declares.
    it("places a nested declaration under its enclosing module", async () => {
        const source = "Outer := module:\n    Inner := module:\n        Count<public>:int = 0\n";

        expect(await locationsFor(source, "Outer/Inner")).toEqual(["/Systems"]);
        expect(await locationsFor(source, "Outer")).toEqual(["/Systems"]);
    });

    it("refuses a nested module named without its enclosing one", async () => {
        expect(await locationsFor("Outer := module:\n    Inner := module:\n", "Inner")).toEqual([]);
    });

    it("matches whole segments, not a directory name that merely ends in one", async () => {
        expect(await locationsFor("Inventory := module:\n", "XSystems/Inventory")).toEqual([]);
    });

    // What the two above cost the user: the import the project compiles with is
    // reported missing, and the one it does not compile with is written out as
    // a path no module answers to.
    it("converts a nested reference, and offers nothing for the bare inner name", async () => {
        const projectVersePath = "/mygame@fortnite.com/mygame";
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([vscode.Uri.file(declaringFile)]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from("Outer := module:\n    Inner := module:\n", "utf8"));

        const convert = (statement: string) => converterWithProjectPath(projectVersePath).convertToFullPath(statement, vscode.Uri.file(`${workspaceRoot}/Content/Scripts/Main.verse`), 0);

        expect((await convert("using { Outer.Inner }"))?.convertedImport).toBe(`using { ${projectVersePath}/Systems/Outer/Inner }`);
        expect(await convert("using { Inner }")).toBeNull();
    });
});

describe("ImportPathConverter declaration scan file cap", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";
    const workspaceRoot = "C:/Project";

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    /**
     * A project of `fileCount` files, each declaring `Inventory`, none of which
     * the folder phases can place. The scan's own cap is what the glob would
     * apply in production, so the count standing in for it here is the count
     * that reaches the phase.
     */
    const scanReturning = (fileCount: number): void => {
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(Array.from({ length: fileCount }, (_, index) => vscode.Uri.file(`${workspaceRoot}/Content/Systems/File${index}.verse`)));
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from("Inventory := module:\n", "utf8"));
    };

    beforeEach(() => {
        setWorkspaceFolders([{ uri: { fsPath: workspaceRoot }, name: "Project", index: 0 }]);
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error("ENOENT"));
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    const convert = (statement: string) => converterWithProjectPath(projectVersePath).convertToFullPath(statement, vscode.Uri.file(`${workspaceRoot}/Content/Scripts/Main.verse`), 0);

    it("reports a scan that stopped short, so a caller can tell it from a completed one", async () => {
        scanReturning(100);

        expect((await converterWithProjectPath(projectVersePath).findModuleLocations("Inventory")).truncated).toBe(true);
    });

    it("reports a scan that read the whole project as complete", async () => {
        scanReturning(99);

        expect((await converterWithProjectPath(projectVersePath).findModuleLocations("Inventory")).truncated).toBe(false);
    });

    // The one location a truncated scan returns is a sample's answer: a namesake
    // in the part it never read would have made the conversion ambiguous, so
    // writing this path unambiguously is the silent wrong module the cap hides.
    it("refuses the conversion rather than writing a sample's answer", async () => {
        scanReturning(100);

        expect(await convert("using { Inventory }")).toBeNull();
    });

    it("converts as before when the scan read the whole project", async () => {
        scanReturning(99);

        expect((await convert("using { Inventory }"))?.convertedImport).toBe(`using { ${projectVersePath}/Systems/Inventory }`);
    });
});

describe("ImportPathConverter.convertToFullPath project-wide folder module search", () => {
    const projectVersePath = "/mygame@fortnite.com/mygame";
    const workspaceRoot = "C:/Project";

    // The tree from the report: the same Combat/Weapons chain under two roots,
    // and an importing file on a third branch that reaches neither of them by
    // any local step - not a sibling, not an ancestor, not a child of Content.
    const verseFiles = ["Content/Scripts/Main.verse", "Content/Systems/Combat/Weapons/Rifle.verse", "Content/Features/Combat/Weapons/Bow.verse"];
    const folders = ["Scripts", "Systems", "Systems/Combat", "Systems/Combat/Weapons", "Features", "Features/Combat", "Features/Combat/Weapons"];

    /** workspaceFolders is readonly in the real typings; the mock is writable. */
    const setWorkspaceFolders = (folders: unknown): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
    };

    beforeEach(() => {
        setWorkspaceFolders([{ uri: { fsPath: workspaceRoot }, name: "Project", index: 0 }]);
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(verseFiles.map((file) => vscode.Uri.file(`${workspaceRoot}/${file}`)));
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: { fsPath: string }) => {
            const contentRelative = uri.fsPath.replace(/\\/g, "/").replace(`${workspaceRoot}/Content/`, "");
            if (!folders.includes(contentRelative)) throw new Error("ENOENT");
            return { type: vscode.FileType.Directory };
        });
    });

    afterEach(() => {
        setWorkspaceFolders(undefined);
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    const convert = (statement: string, contentRelativeFile: string) =>
        converterWithProjectPath(projectVersePath).convertToFullPath(statement, vscode.Uri.file(`${workspaceRoot}/Content/${contentRelativeFile}`), 0);

    // No folder module has a declaration to read, so before this phase existed
    // every search missed the chain and the user was told the module could not
    // be found - with two copies of it in the project.
    it("finds a folder chain outside the file's own ancestry, on every branch holding one", async () => {
        const result = await convert("using { Combat.Weapons }", "Scripts/Main.verse");

        expect(result?.isAmbiguous).toBe(true);
        expect(result?.possiblePaths).toEqual([`${projectVersePath}/Features/Combat/Weapons`, `${projectVersePath}/Systems/Combat/Weapons`]);
    });

    it("converts outright when only one branch holds the chain", async () => {
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
            vscode.Uri.file(`${workspaceRoot}/Content/Scripts/Main.verse`),
            vscode.Uri.file(`${workspaceRoot}/Content/Systems/Combat/Weapons/Rifle.verse`),
        ]);

        const result = await convert("using { Combat.Weapons }", "Scripts/Main.verse");

        expect(result?.isAmbiguous).toBe(false);
        expect(result?.convertedImport).toBe(`using { ${projectVersePath}/Systems/Combat/Weapons }`);
    });

    it("keeps the dotted style the author wrote", async () => {
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([vscode.Uri.file(`${workspaceRoot}/Content/Systems/Combat/Weapons/Rifle.verse`)]);

        expect((await convert("using. Combat.Weapons", "Scripts/Main.verse"))?.convertedImport).toBe(`using. ${projectVersePath}/Systems/Combat/Weapons`);
    });

    // The phase is a fallback, not a widening: a module the local search
    // already places must not be dragged into an ambiguity by a namesake on
    // another branch.
    it("leaves a locally resolved module unambiguous", async () => {
        const result = await convert("using { Combat.Weapons }", "Systems/Economy/Feature.verse");

        expect(result?.isAmbiguous).toBe(false);
        expect(result?.convertedImport).toBe(`using { ${projectVersePath}/Systems/Combat/Weapons }`);
    });

    it("still reports a module no folder in the project holds", async () => {
        expect(await convert("using { Economy.Shop }", "Scripts/Main.verse")).toBeNull();
    });
});

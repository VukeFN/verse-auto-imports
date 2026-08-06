import * as vscode from "vscode";
import { ImportCodeLensProvider } from "../ImportCodeLensProvider";

/**
 * A document that only carries what provideCodeLenses reads: its text, a uri to
 * key hover state on, and a name for the log line.
 */
function documentWith(text: string): vscode.TextDocument {
    return {
        getText: () => text,
        uri: vscode.Uri.file("C:\\project\\Content\\Main.verse"),
        fileName: "C:\\project\\Content\\Main.verse",
        languageId: "verse",
    } as unknown as vscode.TextDocument;
}

/** Titles are what the user sees, and they identify each lens unambiguously. */
async function lensTitlesFor(text: string): Promise<string[]> {
    const provider = new ImportCodeLensProvider(vscode.window.createOutputChannel("test"));
    const lenses = await provider.provideCodeLenses(documentWith(text), {} as vscode.CancellationToken);
    return lenses.map((lens) => lens.command?.title ?? "");
}

describe("ImportCodeLensProvider.provideCodeLenses", () => {
    beforeEach(() => {
        // "always" visibility, so no hover state has to be simulated. Every
        // other setting keeps the caller's default.
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => (key === "pathConversion.codeLensVisibility" ? "always" : defaultValue),
            update: jest.fn(),
        });
    });

    it("offers an absolute-path lens on a live relative import", () => {
        return expect(lensTitlesFor("using { Gadgets.Tools }\n\ncode()")).resolves.toEqual(["$(arrow-both)  Use absolute path"]);
    });

    it("offers a relative-path lens on a live project import", () => {
        return expect(lensTitlesFor("using { /mygame@fortnite.com/mygame/Gadgets }\n\ncode()")).resolves.toEqual(["$(arrow-both)  Use relative path"]);
    });

    it("offers an absolute-path lens on a bare-identifier folder import", () => {
        // A file-level `using { Features }` is a same-directory folder module,
        // and the shared scanner says so. The per-line detection this replaced
        // read the bare identifier as a local-scope using and offered nothing.
        return expect(lensTitlesFor("using { Features }\n\ncode()")).resolves.toEqual(["$(arrow-both)  Use absolute path"]);
    });

    it("offers nothing on a built-in module", () => {
        return expect(lensTitlesFor("using { /Verse.org/Simulation }\n\ncode()")).resolves.toEqual([]);
    });

    it("offers nothing on an import inside a block comment", () => {
        // The lens used to appear here, and acting on it edited a line inside
        // the comment.
        return expect(lensTitlesFor("<#\nusing { /mygame@fortnite.com/mygame/Gadgets }\n#>\n\ncode()")).resolves.toEqual([]);
    });

    it("offers nothing on a module-scoped import inside a module body", () => {
        return expect(lensTitlesFor("MyModule := module:\n    using { Gadgets.Tools }\n\ncode()")).resolves.toEqual([]);
    });

    it("offers nothing on an import whose own line opens a block comment", () => {
        return expect(lensTitlesFor("using { Gadgets.Tools } <#\ndisabled\n#>\n\ncode()")).resolves.toEqual([]);
    });

    it("does not count commented-out imports towards the convert-all lens", () => {
        // One live relative import and one inside a comment is not "multiple",
        // so the convert-all lens must not appear alongside the single one.
        const text = "using { Gadgets.Tools }\n<#\nusing { Other.Tools }\n#>\n\ncode()";
        return expect(lensTitlesFor(text)).resolves.toEqual(["$(arrow-both)  Use absolute path"]);
    });

    it("adds the convert-all lens once a second live import of the same kind exists", () => {
        const text = "using { Gadgets.Tools }\nusing { Other.Tools }\n\ncode()";
        return expect(lensTitlesFor(text)).resolves.toEqual([
            "$(arrow-both)  Use absolute path",
            "$(arrow-swap)  Use absolute paths for all",
            "$(arrow-both)  Use absolute path",
            "$(arrow-swap)  Use absolute paths for all",
        ]);
    });
});

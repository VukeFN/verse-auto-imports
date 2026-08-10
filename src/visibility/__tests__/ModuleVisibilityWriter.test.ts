import * as vscode from "vscode";
import { ProjectPathHandler } from "../../project";
import { ModuleVisibilityWriter } from "../ModuleVisibilityWriter";

const PROJECT = "/mygame@fortnite.com/mygame";
const ROOT = "/repo";

const REQUEST = {
    targetPath: `${PROJECT}/Gadgets/Tools`,
    importerPath: `${PROJECT}/Scripts`,
    moduleName: "Tools",
};

/**
 * Stands the workspace up from one map of workspace-relative path to file text.
 *
 * Text is served through openTextDocument, which is where production reads it,
 * so an offset a test asserts on addresses the same string the writer parsed.
 */
const givenProject = (files: Record<string, string>, root = ROOT): void => {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root), name: root.split("/").pop(), index: 0 }];

    const uris = Object.keys(files).map((relative) => vscode.Uri.file(`${root}/${relative}`));
    const byUri = new Map(uris.map((uri, index) => [uri.toString(), files[Object.keys(files)[index]]]));

    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(uris);
    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
        if (uri.fsPath.replace(/\\/g, "/").endsWith("/Content")) {
            return Promise.resolve({ type: vscode.FileType.Directory });
        }
        return byUri.has(uri.toString()) ? Promise.resolve({ type: vscode.FileType.File }) : Promise.reject(new Error("ENOENT"));
    });
    (vscode.workspace.openTextDocument as jest.Mock).mockImplementation((uri: vscode.Uri) => {
        const content = byUri.get(uri.toString());
        return content === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve({ getText: () => content });
    });
};

const writer = (): ModuleVisibilityWriter => {
    const handler = { getProjectVersePath: jest.fn().mockResolvedValue(PROJECT) } as unknown as ProjectPathHandler;
    return new ModuleVisibilityWriter({} as vscode.OutputChannel, handler);
};

/** The operations of the edit that was applied, or [] when none was. */
const appliedOperations = (): any[] => {
    const calls = (vscode.workspace.applyEdit as jest.Mock).mock.calls;
    return calls.length === 0 ? [] : calls[calls.length - 1][0].operations;
};

const forwardSlashed = (uri: { fsPath: string }): string => String(uri.fsPath).replace(/\\/g, "/");

describe("ModuleVisibilityWriter", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((_key: string, fallback?: unknown) => fallback),
            update: jest.fn(),
        });
    });

    it("creates the definitions file when the target is a plain folder module", async () => {
        givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

        await writer().makeModulePublic(REQUEST);

        const operations = appliedOperations();
        expect(operations[0]).toMatchObject({ kind: "createFile" });
        expect(forwardSlashed(operations[0].uri)).toBe(`${ROOT}/Content/definitions.verse`);
        expect(operations[1]).toMatchObject({ kind: "insert", text: "Gadgets := module:\n    Tools<public> := module {}\n" });
    });

    it("nests the block through the ancestors the target shares with the importer", async () => {
        // Written at the Content root, so a block that skipped Systems would
        // declare an unrelated /proj/Gadgets/Tools and fix nothing.
        givenProject({ "Content/Systems/Scripts/main.verse": "" });

        await writer().makeModulePublic({
            targetPath: `${PROJECT}/Systems/Gadgets/Tools`,
            importerPath: `${PROJECT}/Systems/Scripts`,
            moduleName: "Tools",
        });

        expect(appliedOperations()[1].text).toBe("Systems := module:\n    Gadgets := module:\n        Tools<public> := module {}\n");
    });

    it("honours the configured definitions file name", async () => {
        givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => (key === "moduleVisibility.definitionsFileName" ? "visibility.verse" : fallback)),
            update: jest.fn(),
        });

        await writer().makeModulePublic(REQUEST);

        expect(forwardSlashed(appliedOperations()[0].uri)).toBe(`${ROOT}/Content/visibility.verse`);
    });

    it("extends an existing definitions file rather than replacing it", async () => {
        givenProject({
            "Content/definitions.verse": "Other<public> := module {}\n",
            "Content/Scripts/main.verse": "using { Gadgets.Tools }\n",
        });

        await writer().makeModulePublic(REQUEST);

        const replace = appliedOperations().find((operation) => operation.kind === "replace");
        expect(replace.text).toBe("Other<public> := module {}\n\nGadgets := module:\n    Tools<public> := module {}\n");
    });

    it("folds a specifier edit inside the definitions file into the same replacement", async () => {
        // Two operations on one file would overlap, which VS Code rejects, and
        // half-applying would leave two parts of Deep disagreeing.
        givenProject({ "Content/definitions.verse": "Gadgets := module:\n    Deep := module {}\n" });

        await writer().makeModulePublic({
            targetPath: `${PROJECT}/Gadgets/Deep/Tools`,
            importerPath: `${PROJECT}/Scripts`,
            moduleName: "Tools",
        });

        const operations = appliedOperations();
        expect(operations).toHaveLength(1);
        expect(operations[0].kind).toBe("replace");
        expect(operations[0].text).toBe("Gadgets := module:\n    Deep<public> := module {}\n\nGadgets := module:\n    Deep<public> := module:\n        Tools<public> := module {}\n");
    });

    it("edits an existing declaration instead of writing a second part", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        const operations = appliedOperations();
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({ kind: "insert", text: "<public>" });
        expect(operations[0].position).toEqual(new vscode.Position(0, 5));
    });

    it("names the declaration it rewrote", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("declaring Gadgets/Tools public in place"));
    });

    it("refuses to widen a module the project deliberately narrowed", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools<private> := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Gadgets/Tools is declared private"));
    });

    it("refuses to declare a module inside a scoped one, without quoting it as a specifier it is not", async () => {
        givenProject({ "Content/systems.verse": "Gadgets<scoped{Scripts}> := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        const [warning] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
        expect(warning).toContain("Gadgets is declared scoped");
        // The declaration reads `<scoped{Scripts}>`; printing `<scoped>` would
        // quote the file as saying something that does not compile.
        expect(warning).not.toContain("<scoped>");
    });

    it("does nothing when the module is already public", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools<public> := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("already declared public"));
    });

    it("ignores a namesake module in another branch", async () => {
        givenProject({ "Content/Other/tools.verse": "Tools := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "createFile" });
    });

    it("ignores a declaration that is only inside a block comment", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "<# Tools := module {} #>\n" });

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "createFile" });
    });

    it("refuses a configured file name that is not a plain file name", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => (key === "moduleVisibility.definitionsFileName" ? "../outside.verse" : fallback)),
            update: jest.fn(),
        });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("definitionsFileName must be a plain file name"));
    });

    it("refuses a configured file name the compiler would not read", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => (key === "moduleVisibility.definitionsFileName" ? "definitions.txt" : fallback)),
            update: jest.fn(),
        });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses an empty configured file name, which would address the Content folder", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => (key === "moduleVisibility.definitionsFileName" ? "   " : fallback)),
            update: jest.fn(),
        });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    it("ignores a declaration commented out with the `<#>` marker", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "<#> Tools := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "createFile" });
    });

    it("refuses when no project file resolves the module paths", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        const handler = { getProjectVersePath: jest.fn().mockResolvedValue(null) } as unknown as ProjectPathHandler;

        await new ModuleVisibilityWriter({} as vscode.OutputChannel, handler).makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(".uefnproject"));
    });

    it("refuses rather than creating a Content folder the workspace does not have", async () => {
        givenProject({ "Scripts/main.verse": "" });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("no 'Content' folder"));
    });

    it("warns when the edit is rejected", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(false);

        await writer().makeModulePublic(REQUEST);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("could not write"));
    });

    it("resolves paths without the Content prefix when the workspace is Content itself", async () => {
        givenProject({ "Gadgets/tools.verse": "Tools := module {}\n" }, "/repo/Content");

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "insert", text: "<public>" });
    });
});

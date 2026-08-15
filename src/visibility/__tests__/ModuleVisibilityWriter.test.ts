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
 * What happens to a file between the scan that reads it and the check that runs
 * before the write, keyed by URI. Empty means every file holds still.
 */
const afterScan = new Map<string, "changed" | "gone" | "created">();

/**
 * Stands the workspace up from one map of workspace-relative path to file text.
 *
 * Text is served through openTextDocument, which is where production reads it,
 * so an offset a test asserts on addresses the same string the writer parsed.
 * Each read is counted, because the writer reads a file once to scan it and
 * again to check it still stands: an entry in `afterScan` changes what the
 * second read answers.
 */
const givenProject = (files: Record<string, string>, root = ROOT): vscode.Uri[] => {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root), name: root.split("/").pop(), index: 0 }];

    const uris = Object.keys(files).map((relative) => vscode.Uri.file(`${root}/${relative}`));
    const byUri = new Map(uris.map((uri, index) => [uri.toString(), files[Object.keys(files)[index]]]));
    const opens = new Map<string, number>();
    const stats = new Map<string, number>();

    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(uris);
    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
        if (uri.fsPath.replace(/\\/g, "/").endsWith("/Content")) {
            return Promise.resolve({ type: vscode.FileType.Directory });
        }
        const key = uri.toString();
        if (afterScan.get(key) === "created") {
            const seen = (stats.get(key) ?? 0) + 1;
            stats.set(key, seen);
            return seen === 1 ? Promise.reject(new Error("ENOENT")) : Promise.resolve({ type: vscode.FileType.File });
        }
        return byUri.has(key) ? Promise.resolve({ type: vscode.FileType.File }) : Promise.reject(new Error("ENOENT"));
    });
    (vscode.workspace.openTextDocument as jest.Mock).mockImplementation((uri: vscode.Uri) => {
        const key = uri.toString();
        const content = byUri.get(key);
        if (content === undefined) {
            return Promise.reject(new Error("ENOENT"));
        }

        const seen = (opens.get(key) ?? 0) + 1;
        opens.set(key, seen);
        const fate = seen === 1 ? undefined : afterScan.get(key);
        if (fate === "gone") {
            return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve({ getText: () => content, version: fate === "changed" ? 2 : 1 });
    });

    return uris;
};

/**
 * Says what happens to a file after the scan has read it: an edit that moves
 * its version on, a delete, or a creation of a file that was not there. Call
 * after givenProject.
 */
const duringScan = (relative: string, fate: "changed" | "gone" | "created", root = ROOT): void => {
    afterScan.set(vscode.Uri.file(`${root}/${relative}`).toString(), fate);
};

/**
 * Adds a file the scan lists but cannot open, as one deleted between findFiles
 * and the read behaves. Call after givenProject, whose URIs it extends.
 */
const alsoListsUnreadable = (listed: readonly vscode.Uri[], relative: string): vscode.Uri => {
    const uri = vscode.Uri.file(`${ROOT}/${relative}`);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([...listed, uri]);
    return uri;
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
        afterScan.clear();
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
        expect(forwardSlashed(operations[0].uri)).toBe(`${ROOT}/Content/_definitions.verse`);
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
            "Content/_definitions.verse": "Other<public> := module {}\n",
            "Content/Scripts/main.verse": "using { Gadgets.Tools }\n",
        });

        await writer().makeModulePublic(REQUEST);

        const replace = appliedOperations().find((operation) => operation.kind === "replace");
        expect(replace.text).toBe("Other<public> := module {}\n\nGadgets := module:\n    Tools<public> := module {}\n");
    });

    it("folds a specifier edit inside the definitions file into the same replacement", async () => {
        // Two operations on one file would overlap, which VS Code rejects, and
        // half-applying would leave two parts of Deep disagreeing.
        givenProject({ "Content/_definitions.verse": "Gadgets := module:\n    Deep := module {}\n" });

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
        // "widening" is what separates this refusal from the nesting one below;
        // the module name alone appears in both.
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("widening Gadgets/Tools, declared private"));
    });

    it("refuses to declare a module inside a scoped one, without quoting it as a specifier it is not", async () => {
        givenProject({ "Content/systems.verse": "Gadgets<scoped{Scripts}> := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        const [warning] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
        expect(warning).toContain("declaring a module inside Gadgets, declared scoped");
        // The declaration reads `<scoped{Scripts}>`; printing `<scoped>` would
        // quote the file as saying something that does not compile.
        expect(warning).not.toContain("<scoped>");
    });

    it("refuses when a scanned file was edited during the scan, naming it", async () => {
        // The offsets came from text that is no longer what the file holds, so
        // applying the edit would put the specifier in the wrong place.
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module {}\n" });
        duringScan("Content/Gadgets/tools.verse", "changed");

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("'Content/Gadgets/tools.verse' changed while the project was scanned"));
    });

    it("refuses when a scanned file can no longer be read before the write", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module {}\n" });
        duringScan("Content/Gadgets/tools.verse", "gone");

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("'Content/Gadgets/tools.verse' changed while the project was scanned"));
    });

    it("refuses when the definitions file appeared during the scan", async () => {
        // The create carries ignoreIfExists, so without this the insert would
        // prepend the block to whatever the user just wrote in that file.
        givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
        duringScan("Content/_definitions.verse", "created");

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("'Content/_definitions.verse' changed while the project was scanned"));
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

    it("refuses when a project file the scan listed cannot be read", async () => {
        const listed = givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
        alsoListsUnreadable(listed, "Content/Gadgets/hidden.verse");

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        // A success notification here would report a half-written module as
        // done, so its absence is half of what the refusal is worth.
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Content/Gadgets/hidden.verse"));
    });

    it("refuses even where the files it could read already answer the request", async () => {
        // Completeness of the scan gates the write, not its result: the file
        // that could not be read may hold a part of Tools that rewriting this
        // one would contradict.
        const listed = givenProject({ "Content/Gadgets/tools.verse": "Tools := module:\n    X:int = 1\n" });
        alsoListsUnreadable(listed, "Content/Gadgets/more-tools.verse");

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    it("proceeds when the file it could not read sits outside Content", async () => {
        // The outside-Content test has to stay ahead of the open: a file there
        // declares nothing the request can contradict, and refusing on one
        // would stop every project that keeps .verse files outside Content.
        const listed = givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
        alsoListsUnreadable(listed, "Plugins/other.verse");

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "createFile" });
    });

    it("resolves paths without the Content prefix when the workspace is Content itself", async () => {
        givenProject({ "Gadgets/tools.verse": "Tools := module {}\n" }, "/repo/Content");

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "insert", text: "<public>" });
    });
});

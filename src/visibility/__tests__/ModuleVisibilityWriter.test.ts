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

/** The workspace as one map of workspace-relative path to file text. */
const givenProject = (files: Record<string, string>): void => {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(ROOT), name: "repo", index: 0 }];

    const uris = Object.keys(files).map((relative) => vscode.Uri.file(`${ROOT}/${relative}`));
    const byUri = new Map(uris.map((uri, index) => [uri.toString(), files[Object.keys(files)[index]]]));

    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(uris);
    (vscode.workspace.fs.readFile as jest.Mock).mockImplementation((uri: vscode.Uri) => {
        const content = byUri.get(uri.toString());
        return content === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(Buffer.from(content, "utf8"));
    });
    (vscode.workspace.openTextDocument as jest.Mock).mockImplementation((uri: vscode.Uri) => {
        const content = byUri.get(uri.toString()) ?? "";
        return Promise.resolve({
            getText: () => content,
            positionAt: (offset: number) => {
                const before = content.slice(0, offset).split("\n");
                return new vscode.Position(before.length - 1, before[before.length - 1].length);
            },
        });
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
        expect(String(operations[0].uri.fsPath).replace(/\\/g, "/")).toBe(`${ROOT}/Content/definitions.verse`);
        expect(operations[1]).toMatchObject({ kind: "insert", text: "Gadgets := module:\n    Tools<public> := module {}\n" });
    });

    it("honours the configured definitions file name", async () => {
        givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => (key === "moduleVisibility.definitionsFileName" ? "visibility.verse" : fallback)),
            update: jest.fn(),
        });

        await writer().makeModulePublic(REQUEST);

        expect(String(appliedOperations()[0].uri.fsPath).replace(/\\/g, "/")).toBe(`${ROOT}/Content/visibility.verse`);
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

    it("edits an existing declaration instead of writing a second part", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        const operations = appliedOperations();
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({ kind: "insert", text: "<public>" });
        expect(operations[0].position).toEqual(new vscode.Position(0, 5));
    });

    it("refuses to widen a module the project deliberately narrowed", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools<private> := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Gadgets/Tools is <private>"));
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

    it("refuses when no project file resolves the module paths", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        const handler = { getProjectVersePath: jest.fn().mockResolvedValue(null) } as unknown as ProjectPathHandler;

        await new ModuleVisibilityWriter({} as vscode.OutputChannel, handler).makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(".uefnproject"));
    });

    it("warns when the edit is rejected", async () => {
        givenProject({ "Content/Scripts/main.verse": "" });
        (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(false);

        await writer().makeModulePublic(REQUEST);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("could not write"));
    });

    it("resolves paths without the Content prefix when the workspace is Content itself", async () => {
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file("/repo/Content"), name: "Content", index: 0 }];
        const uri = vscode.Uri.file("/repo/Content/Gadgets/tools.verse");
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([uri]);
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation((target: vscode.Uri) =>
            target.toString() === uri.toString() ? Promise.resolve(Buffer.from("Tools := module {}\n", "utf8")) : Promise.reject(new Error("ENOENT")),
        );
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
            getText: () => "Tools := module {}\n",
            positionAt: (offset: number) => new vscode.Position(0, offset),
        });

        await writer().makeModulePublic(REQUEST);

        expect(appliedOperations()[0]).toMatchObject({ kind: "insert", text: "<public>" });
    });
});

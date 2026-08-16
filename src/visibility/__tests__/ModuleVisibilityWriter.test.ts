import * as vscode from "vscode";
import { ProjectPathHandler } from "../../project";
import { logger } from "../../utils";
import { ModuleVisibilityWriter } from "../ModuleVisibilityWriter";

const PROJECT = "/mygame@fortnite.com/mygame";
const ROOT = "/repo";

/** The second root of a multi-root workspace, which the quick fix is invoked under. */
const OTHER_ROOT = "/second";

/** A root holding no Content folder, as an art or notes folder opened alongside a project. */
const NOTES_ROOT = "/notes";

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

/**
 * Stands the same project up under the second of two workspace folders, and
 * returns the document URI the quick fix would pass. The first folder is
 * registered and holds nothing, so a writer resolving to it fails here rather
 * than passing by coincidence.
 */
const givenSecondFolderProject = (files: Record<string, string>): vscode.Uri => {
    givenProject(files, OTHER_ROOT);
    (vscode.workspace as any).workspaceFolders = [
        { uri: vscode.Uri.file(ROOT), name: "repo", index: 0 },
        { uri: vscode.Uri.file(OTHER_ROOT), name: "second", index: 1 },
    ];

    return vscode.Uri.file(`${OTHER_ROOT}/Content/Scripts/main.verse`);
};

/** A definitionsFileName override that answers differently per workspace folder. */
const givenPerFolderDefinitionsName = (byRoot: Record<string, string>): void => {
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((_section: string, resource?: { fsPath: string }) => {
        const root = resource && Object.keys(byRoot).find((candidate) => forwardSlashed(resource).startsWith(`${candidate}/`));
        return {
            get: jest.fn().mockImplementation((key: string, fallback?: unknown) => (key === "moduleVisibility.definitionsFileName" && root ? byRoot[root] : fallback)),
            update: jest.fn(),
        };
    });
};

/**
 * @param rootPluginName what the project file declares as its root plugin, which
 *   is what admits a Content root nested under `Plugins/<name>`. Left unset, the
 *   project declares none and only a Content directly under a workspace folder
 *   is found.
 */
const writer = (rootPluginName: string | null = null): ModuleVisibilityWriter => {
    const handler = {
        getProjectVersePath: jest.fn().mockResolvedValue(PROJECT),
        getRootPluginName: jest.fn().mockResolvedValue(rootPluginName),
    } as unknown as ProjectPathHandler;
    return new ModuleVisibilityWriter({} as vscode.OutputChannel, handler);
};

/** The operations of the edit that was applied, or [] when none was. */
const appliedOperations = (): any[] => {
    const calls = (vscode.workspace.applyEdit as jest.Mock).mock.calls;
    return calls.length === 0 ? [] : calls[calls.length - 1][0].operations;
};

/** The metadata argument of the last applyEdit call, or undefined when there was none. */
const appliedMetadata = (): any => {
    const calls = (vscode.workspace.applyEdit as jest.Mock).mock.calls;
    return calls.length === 0 ? undefined : calls[calls.length - 1][1];
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

    it("refuses to append a second definition of a module the definitions file already declares", async () => {
        // The file the fix wrote on an earlier run. Appending a block through
        // Gadgets and Deep would leave that one file defining each of them
        // twice, which the second run has no way to make compile.
        givenProject({ "Content/_definitions.verse": "Gadgets := module:\n    Deep := module {}\n" });

        await writer().makeModulePublic({
            targetPath: `${PROJECT}/Gadgets/Deep/Tools`,
            importerPath: `${PROJECT}/Scripts`,
            moduleName: "Tools",
        });

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("re-declaring Gadgets and Gadgets/Deep"));
    });

    it("punctuates a list of repeats so a path carrying a keyword cannot be read as two", async () => {
        // One conflict per declared ancestor, so three is ordinary rather than
        // exotic. Joined with bare "and" throughout, the keyword clause fuses
        // with the path after it and the reader cannot tell them apart.
        givenProject({ "Content/_definitions.verse": "Gadgets := module:\n    Deep := module:\n        Tools<internal> := module {}\n" });

        await writer().makeModulePublic({
            targetPath: `${PROJECT}/Gadgets/Deep/Tools/More`,
            importerPath: `${PROJECT}/Scripts`,
            moduleName: "More",
        });

        const [warning] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
        expect(warning).toContain("re-declaring Gadgets, Gadgets/Deep, and Gadgets/Deep/Tools (declared internal)");
    });

    it("refuses when an ancestor is declared in a user file, naming the declaration the chain would repeat", async () => {
        givenProject({ "Content/gadgets.verse": "Gadgets<internal> := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("re-declaring Gadgets (declared internal)"));
    });

    it("edits an existing declaration instead of writing a second part", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        const operations = appliedOperations();
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({ kind: "insert", text: "<public>" });
        expect(operations[0].position).toEqual(new vscode.Position(0, 5));
    });

    it("names the declaration it offered to rewrite", async () => {
        // In the log rather than the notification: the preview can apply a
        // subset, so this names what was offered, not what was written.
        givenProject({ "Content/Gadgets/tools.verse": "Tools := module {}\n" });
        const info = jest.spyOn(logger, "info").mockImplementation();

        try {
            await writer().makeModulePublic(REQUEST);

            expect(info).toHaveBeenCalledWith("ModuleVisibilityWriter", expect.any(String), {
                intended: expect.stringContaining("declaring Gadgets/Tools public in place"),
            });
        } finally {
            // The logger is a singleton, so leaving the stub installed would
            // silently swallow errors in any test added after this one.
            jest.restoreAllMocks();
        }
    });

    it("refuses to widen a module the project deliberately narrowed", async () => {
        givenProject({ "Content/Gadgets/tools.verse": "Tools<private> := module {}\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        // "widening" is what separates this refusal from the nesting one below;
        // the module name alone appears in both.
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("widening Gadgets/Tools (declared private)"));
    });

    it("refuses to declare a module inside a scoped one, without quoting it as a specifier it is not", async () => {
        givenProject({ "Content/systems.verse": "Gadgets<scoped{Scripts}> := module:\n    X:int = 1\n" });

        await writer().makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        const [warning] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
        expect(warning).toContain("declaring a module inside Gadgets (declared scoped)");
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
        const handler = {
            getProjectVersePath: jest.fn().mockResolvedValue(null),
            getRootPluginName: jest.fn().mockResolvedValue(null),
        } as unknown as ProjectPathHandler;

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

    it("reports nothing written when the preview comes back empty", async () => {
        // A cancelled preview, one nothing was ticked in, and a failed apply
        // are one boolean, so this must not be phrased as a failure.
        givenProject({ "Content/Scripts/main.verse": "" });
        (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(false);

        await writer().makeModulePublic(REQUEST);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no changes were written"));
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
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

    describe("refactor preview", () => {
        // needsConfirmation on an entry is the only lever an extension has on
        // the preview: applyEdit's isRefactoring flag maps to the auto-save
        // setting and opens nothing. An entry without it applies unseen.
        it("marks every entry of a definitions-file write as needing confirmation", async () => {
            givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST);

            const operations = appliedOperations();
            expect(operations.length).toBeGreaterThan(0);
            for (const operation of operations) {
                // The module path, not the file name, so the description still
                // says something in the preview's default group-by-file view.
                expect(operation.metadata).toMatchObject({ needsConfirmation: true, description: "Gadgets/Tools" });
            }
        });

        it("marks a specifier rewrite as needing confirmation too", async () => {
            givenProject({ "Gadgets/tools.verse": "Tools := module {}\n" }, "/repo/Content");

            await writer().makeModulePublic(REQUEST);

            expect(appliedOperations()[0]).toMatchObject({
                kind: "insert",
                text: "<public>",
                metadata: { needsConfirmation: true },
            });
        });

        // The two replace sites, which the insert cases above do not reach.
        // Rewriting the definitions file end to end is the most destructive
        // entry the writer emits, so an unpreviewed one is the worst version
        // of the defect this ticket exists to close.
        it("marks a whole-file rewrite of an existing definitions file as needing confirmation", async () => {
            // The file has to exist to be replaced rather than created, and to
            // declare nothing on the target's own path: a declaration there
            // would be one the appended block re-declares, and the request
            // would be refused before any operation was built.
            givenProject({ "Content/_definitions.verse": "Other<public> := module {}\n" });

            await writer().makeModulePublic(REQUEST);

            expect(appliedOperations()[0]).toMatchObject({
                kind: "replace",
                metadata: { needsConfirmation: true },
            });
        });

        it("marks a widened specifier as needing confirmation", async () => {
            givenProject({ "Content/Gadgets/tools.verse": "Tools<internal> := module {}\n" });

            await writer().makeModulePublic(REQUEST);

            expect(appliedOperations()[0]).toMatchObject({
                kind: "replace",
                text: "<public>",
                metadata: { needsConfirmation: true },
            });
        });

        it("gives every entry one label, which is what groups them under a single node", async () => {
            givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST);

            const labels = new Set(appliedOperations().map((operation) => operation.metadata?.label));
            expect([...labels]).toEqual(["Make module 'Tools' public"]);
        });

        it("tells the editor the edit is a refactoring, so files.refactoring.autoSave applies", async () => {
            givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST);

            expect(appliedMetadata()).toEqual({ isRefactoring: true });
        });

        it("does not claim which declarations landed, since the preview can apply a subset", async () => {
            givenProject({ "Content/Gadgets/tools.verse": "Tools := module {}\n" });

            await writer().makeModulePublic(REQUEST);

            const [message] = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0];
            expect(message).toContain("previewed");
            expect(message).not.toContain("declaring");
        });
    });

    describe("multi-root workspace", () => {
        it("writes under the folder holding the document the fix was invoked from", async () => {
            const source = givenSecondFolderProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST, source);

            expect(forwardSlashed(appliedOperations()[0].uri)).toBe(`${OTHER_ROOT}/Content/_definitions.verse`);
        });

        it("honours that folder's definitionsFileName rather than the first folder's", async () => {
            const source = givenSecondFolderProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
            givenPerFolderDefinitionsName({ [ROOT]: "first.verse", [OTHER_ROOT]: "second.verse" });

            await writer().makeModulePublic(REQUEST, source);

            expect(forwardSlashed(appliedOperations()[0].uri)).toBe(`${OTHER_ROOT}/Content/second.verse`);
        });

        it("scans that folder for existing declarations, not the first", async () => {
            const source = givenSecondFolderProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST, source);

            // The scan is rooted at the Content root the write goes to, so the
            // folder written and the folder read cannot come apart.
            const [pattern] = (vscode.workspace.findFiles as jest.Mock).mock.calls[0];
            expect(forwardSlashed(pattern.base)).toBe(`${OTHER_ROOT}/Content`);
        });

        it("falls back to the first folder when the caller names no document", async () => {
            givenSecondFolderProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST);

            expect(forwardSlashed(appliedOperations()[0].uri)).toBe(`${ROOT}/Content/_definitions.verse`);
        });

        it("falls back to the first folder for a document under no folder at all", async () => {
            givenSecondFolderProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });

            await writer().makeModulePublic(REQUEST, vscode.Uri.file("/elsewhere/scratch.verse"));

            expect(forwardSlashed(appliedOperations()[0].uri)).toBe(`${ROOT}/Content/_definitions.verse`);
        });

        it("falls back to the first folder when the document's own folder holds no Content root", async () => {
            givenProject({ "Content/Scripts/main.verse": "using { Gadgets.Tools }\n" });
            (vscode.workspace as any).workspaceFolders = [
                { uri: vscode.Uri.file(ROOT), name: "repo", index: 0 },
                { uri: vscode.Uri.file(NOTES_ROOT), name: "notes", index: 1 },
            ];
            const stat = vscode.workspace.fs.stat as jest.Mock;
            const base = stat.getMockImplementation()!;
            stat.mockImplementation((uri: vscode.Uri) => (forwardSlashed(uri) === `${NOTES_ROOT}/Content` ? Promise.reject(new Error("ENOENT")) : base(uri)));

            await writer().makeModulePublic(REQUEST, vscode.Uri.file(`${NOTES_ROOT}/scratch.verse`));

            expect(forwardSlashed(appliedOperations()[0].uri)).toBe(`${ROOT}/Content/_definitions.verse`);
        });
    });
});

// UEFN nests a project's Verse under <project>/Plugins/<Name>/Content, so a
// workspace opened at the project root holds no Content at its own top level.
// While the root was read at one fixed depth, the quick fix refused every such
// project with "no 'Content' folder was found in the workspace" - the one layout
// import conversion had already been taught to handle.
describe("ModuleVisibilityWriter under a nested plugin Content root", () => {
    const ROOT_PLUGIN = "MyGame";
    const CONTENT_ROOT = `${ROOT}/Plugins/${ROOT_PLUGIN}/Content`;

    /**
     * Stands the project up under the nested Content root, from one map of
     * root-relative path to file text. Nothing but that root stats as a
     * directory, so a writer still reading the boundary at depth zero finds no
     * Content folder here rather than passing by coincidence.
     */
    const givenNestedProject = (files: Record<string, string>): void => {
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(ROOT), name: "repo", index: 0 }];

        const byUri = new Map(Object.entries(files).map(([relative, text]) => [vscode.Uri.file(`${CONTENT_ROOT}/${relative}`).toString(), text]));

        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([...byUri.keys()].map((key) => vscode.Uri.file(key.replace(/^file:\/\//, ""))));
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
            if (forwardSlashed(uri) === CONTENT_ROOT) return Promise.resolve({ type: vscode.FileType.Directory });
            return byUri.has(uri.toString()) ? Promise.resolve({ type: vscode.FileType.File }) : Promise.reject(new Error("ENOENT"));
        });
        (vscode.workspace.openTextDocument as jest.Mock).mockImplementation((uri: vscode.Uri) => {
            const text = byUri.get(uri.toString());
            return text === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve({ getText: () => text, version: 1 });
        });
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn().mockImplementation((_key: string, fallback?: unknown) => fallback),
            update: jest.fn(),
        });
    });

    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = undefined;
        (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error("ENOENT"));
    });

    it("writes the definitions file at the nested Content root", async () => {
        givenNestedProject({ "Scripts/main.verse": "using { Gadgets.Tools }\n" });

        await writer(ROOT_PLUGIN).makeModulePublic(REQUEST);

        const operations = appliedOperations();
        expect(forwardSlashed(operations[0].uri)).toBe(`${CONTENT_ROOT}/_definitions.verse`);
        expect(operations[1]).toMatchObject({ kind: "insert", text: "Gadgets := module:\n    Tools<public> := module {}\n" });
    });

    // The scan has to sweep the same root the write goes to: a declaration it
    // never reached becomes a second, conflicting part in the definitions file.
    it("rewrites a declaration the scan finds under the nested root, rather than repeating it", async () => {
        givenNestedProject({ "Gadgets/tools.verse": "Tools := module {}\n" });

        await writer(ROOT_PLUGIN).makeModulePublic(REQUEST);

        const operations = appliedOperations();
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({ kind: "insert", text: "<public>" });
        expect(forwardSlashed(operations[0].uri)).toBe(`${CONTENT_ROOT}/Gadgets/tools.verse`);
    });

    it("refuses when the project declares no root plugin, so no nested root is addressable", async () => {
        givenNestedProject({ "Scripts/main.verse": "using { Gadgets.Tools }\n" });

        await writer(null).makeModulePublic(REQUEST);

        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("no 'Content' folder"));
    });
});

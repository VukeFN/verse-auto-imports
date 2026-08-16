import * as fs from "fs";
import * as vscode from "vscode";
import { ProjectPathHandler } from "../ProjectPathHandler";

/**
 * Regression tests for issue #450: the handler searched every workspace folder
 * for a `.uefnproject` but returned on the first one it found and cached it on
 * the instance, so in a multi-root workspace holding two UEFN projects every
 * answer described whichever project sat in the lowest-indexed folder.
 *
 * These drive the real folder search through the vscode mock rather than a
 * stubbed resolver, because the defect was in which directory was searched.
 */
describe("ProjectPathHandler", () => {
    const FIRST_ROOT = "/workspace/first";
    const SECOND_ROOT = "/workspace/second";
    const NOTES_ROOT = "/workspace/notes";

    const projectFor = (name: string) => ({
        title: name,
        bindings: {
            projectVersePath: `/mygame@fortnite.com/${name.toLowerCase()}`,
            modules: { [name]: `${name}.versemodule` },
        },
        plugins: [{ name, bIsRoot: true }],
    });

    const FIRST = projectFor("FirstGame");
    const SECOND = projectFor("SecondGame");

    /** Directory holding a `.uefnproject` -> its content, parsed or raw text. */
    let projectsByDirectory: Map<string, unknown>;
    /** Project files read, in order, so a cache hit can be told from a miss. */
    let reads: string[];
    let handler: ProjectPathHandler;

    const forwardSlashed = (fsPath: string) => fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const projectPathIn = (directory: string) => `${directory}/Project.uefnproject`;

    /** Registers the workspace folders in the order VS Code would index them. */
    const givenWorkspaceFolders = (...roots: string[]): void => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = roots.map((root, index) => ({
            uri: vscode.Uri.file(root),
            name: root.split("/").pop() ?? root,
            index,
        }));
    };

    /** Puts a `.uefnproject` in each named directory and nowhere else. */
    const givenProjectsIn = (byDirectory: Record<string, unknown>): void => {
        projectsByDirectory = new Map(Object.entries(byDirectory));
    };

    const fileIn = (root: string) => vscode.Uri.file(`${root}/Content/main.verse`);

    beforeEach(() => {
        reads = [];
        projectsByDirectory = new Map();

        // findFiles is a bare mockResolvedValue([]) on the shared mock, so the
        // per-directory answer has to be supplied here. The pattern's base is a
        // WorkspaceFolder when the handler searches a folder and a Uri when it
        // walks up from one, so both shapes have to be unwrapped.
        (vscode.workspace.findFiles as jest.Mock).mockImplementation(async (pattern: { base: { uri?: { fsPath: string }; fsPath?: string } }) => {
            const base = pattern.base.uri ?? (pattern.base as { fsPath: string });
            const directory = forwardSlashed(base.fsPath);

            return projectsByDirectory.has(directory) ? [vscode.Uri.file(projectPathIn(directory))] : [];
        });

        jest.spyOn(fs, "readFileSync").mockImplementation(((target: string): string => {
            const requested = forwardSlashed(String(target));
            reads.push(requested);

            const project = projectsByDirectory.get(requested.replace(/\/Project\.uefnproject$/, ""));
            if (project === undefined) {
                throw new Error(`ENOENT: ${requested}`);
            }

            return typeof project === "string" ? project : JSON.stringify(project);
        }) as unknown as typeof fs.readFileSync);

        handler = new ProjectPathHandler(vscode.window.createOutputChannel("test"));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        (vscode.workspace.findFiles as jest.Mock).mockReset().mockResolvedValue([]);
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    it("answers for the project in the folder the file belongs to", async () => {
        givenWorkspaceFolders(FIRST_ROOT, SECOND_ROOT);
        givenProjectsIn({ [FIRST_ROOT]: FIRST, [SECOND_ROOT]: SECOND });

        // The first folder is asked first on purpose: the defect was that the
        // first answer became every later answer.
        const first = await handler.getProjectVersePath(fileIn(FIRST_ROOT));
        const second = await handler.getProjectVersePath(fileIn(SECOND_ROOT));

        expect(first).toBe("/mygame@fortnite.com/firstgame");
        expect(second).toBe("/mygame@fortnite.com/secondgame");
    });

    it("scopes the name, the root plugin and the module map to the same folder", async () => {
        givenWorkspaceFolders(FIRST_ROOT, SECOND_ROOT);
        givenProjectsIn({ [FIRST_ROOT]: FIRST, [SECOND_ROOT]: SECOND });
        await handler.getProjectName(fileIn(FIRST_ROOT));

        const second = fileIn(SECOND_ROOT);

        expect(await handler.getProjectName(second)).toBe("SecondGame");
        expect(await handler.getRootPluginName(second)).toBe("SecondGame");
        expect(await handler.getProjectModules(second)).toEqual({ SecondGame: "SecondGame.versemodule" });
    });

    it("walks up from the file's own folder rather than the first one", async () => {
        const deepRoot = `${SECOND_ROOT}/Plugins/SecondGame/Content`;
        givenWorkspaceFolders(FIRST_ROOT, deepRoot);
        givenProjectsIn({ [FIRST_ROOT]: FIRST, [SECOND_ROOT]: SECOND });

        expect(await handler.getProjectVersePath(vscode.Uri.file(`${deepRoot}/main.verse`))).toBe("/mygame@fortnite.com/secondgame");
    });

    // The directory is what anchors Plugins/<root>/Content on disk, so it has
    // to name where the file was found, the parent-walk case included.
    it("exposes the directory the project file was read from", async () => {
        givenWorkspaceFolders(FIRST_ROOT);
        givenProjectsIn({ [FIRST_ROOT]: FIRST });

        expect(await handler.getProjectFileDirectory(fileIn(FIRST_ROOT))).toBe(FIRST_ROOT);
    });

    it("exposes the parent directory the walk found the project file in", async () => {
        const pluginsRoot = `${SECOND_ROOT}/Plugins`;
        givenWorkspaceFolders(pluginsRoot);
        givenProjectsIn({ [SECOND_ROOT]: SECOND });

        expect(await handler.getProjectFileDirectory(vscode.Uri.file(`${pluginsRoot}/SecondGame/Content/main.verse`))).toBe(SECOND_ROOT);
    });

    it("searches every folder when nothing names one", async () => {
        givenWorkspaceFolders(NOTES_ROOT, SECOND_ROOT);
        givenProjectsIn({ [SECOND_ROOT]: SECOND });

        expect(await handler.getProjectVersePath()).toBe("/mygame@fortnite.com/secondgame");
    });

    it("falls back to the workspace for a file under no folder", async () => {
        givenWorkspaceFolders(NOTES_ROOT, SECOND_ROOT);
        givenProjectsIn({ [SECOND_ROOT]: SECOND });

        expect(await handler.getProjectVersePath(vscode.Uri.file("/elsewhere/scratch.verse"))).toBe("/mygame@fortnite.com/secondgame");
    });

    it("answers nothing rather than another project when the file will not parse", async () => {
        givenWorkspaceFolders(FIRST_ROOT, SECOND_ROOT);
        givenProjectsIn({ [FIRST_ROOT]: FIRST, [SECOND_ROOT]: "{ not json" });

        expect(await handler.getProjectVersePath(fileIn(SECOND_ROOT))).toBeNull();
    });

    it("parses a folder's project file once", async () => {
        givenWorkspaceFolders(FIRST_ROOT, SECOND_ROOT);
        givenProjectsIn({ [FIRST_ROOT]: FIRST, [SECOND_ROOT]: SECOND });
        const second = fileIn(SECOND_ROOT);

        await handler.getProjectVersePath(second);
        await handler.getProjectName(second);

        expect(reads).toEqual([projectPathIn(SECOND_ROOT)]);
    });

    it("clears every folder's entry, not only one", async () => {
        givenWorkspaceFolders(FIRST_ROOT, SECOND_ROOT);
        givenProjectsIn({ [FIRST_ROOT]: FIRST, [SECOND_ROOT]: SECOND });
        await handler.getProjectVersePath(fileIn(FIRST_ROOT));
        await handler.getProjectVersePath(fileIn(SECOND_ROOT));
        reads = [];

        handler.clearCache();
        await handler.getProjectVersePath(fileIn(FIRST_ROOT));
        await handler.getProjectVersePath(fileIn(SECOND_ROOT));

        expect(reads).toEqual([projectPathIn(FIRST_ROOT), projectPathIn(SECOND_ROOT)]);
    });
});

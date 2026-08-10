import * as vscode from "vscode";
import { ModuleVisibilityCodeActionProvider } from "../ModuleVisibilityCodeActionProvider";

const INACCESSIBLE =
    "Invalid access of internal module `(/mygame@fortnite.com/mygame/Gadgets:)Tools` from module `/mygame@fortnite.com/mygame/Scripts`. Consider setting the module's access specifier to <public> to make it accessible from other modules within your project.";

const diagnostic = (message: string) => ({ message }) as vscode.Diagnostic;

const provide = (...messages: string[]) => {
    const provider = new ModuleVisibilityCodeActionProvider();
    const context = { diagnostics: messages.map(diagnostic) } as unknown as vscode.CodeActionContext;
    return provider.provideCodeActions({} as vscode.TextDocument, {} as vscode.Range, context);
};

describe("ModuleVisibilityCodeActionProvider", () => {
    it("offers one action naming the module", () => {
        const actions = provide(INACCESSIBLE);

        expect(actions).toHaveLength(1);
        expect(actions![0].title).toBe("Make module 'Tools' public");
    });

    it("sends the parsed request to the command rather than the raw message", () => {
        const actions = provide(INACCESSIBLE);

        expect(actions![0].command).toEqual({
            title: "Make Module Public",
            command: "verseAutoImports.makeModulePublic",
            arguments: [
                {
                    targetPath: "/mygame@fortnite.com/mygame/Gadgets/Tools",
                    importerPath: "/mygame@fortnite.com/mygame/Scripts",
                    moduleName: "Tools",
                },
            ],
        });
    });

    it("attaches the diagnostic it answers", () => {
        const actions = provide(INACCESSIBLE);

        expect(actions![0].diagnostics?.[0].message).toBe(INACCESSIBLE);
    });

    it("offers nothing for a diagnostic an import would fix", () => {
        expect(provide("Unknown identifier `button_device`. Did you forget to specify using { /Fortnite.com/Devices }")).toBeUndefined();
    });

    it("offers nothing when there are no diagnostics", () => {
        expect(provide()).toBeUndefined();
    });

    it("answers only the matching diagnostic when several are reported at once", () => {
        const actions = provide("Unknown identifier `button_device`.", INACCESSIBLE);

        expect(actions).toHaveLength(1);
    });
});

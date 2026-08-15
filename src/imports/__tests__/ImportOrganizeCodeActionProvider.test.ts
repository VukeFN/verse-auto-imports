import * as vscode from "vscode";
import { ImportOrganizeCodeActionProvider } from "../ImportOrganizeCodeActionProvider";

// Regression for #387: the extension registered quick-fix providers only, so
// VS Code's own Organize Imports - Shift+Alt+O, the Source Action menu, and
// editor.codeActionsOnSave - reached nothing in a .verse file and gave the user
// no sign that nothing had happened.

function makeDocument(): vscode.TextDocument {
    return {
        uri: vscode.Uri.file("C:\\Project\\Content\\device.verse"),
        languageId: "verse",
    } as unknown as vscode.TextDocument;
}

describe("ImportOrganizeCodeActionProvider", () => {
    it("declares source.organizeImports to the registration", () => {
        expect(ImportOrganizeCodeActionProvider.providedCodeActionKinds.map((kind) => kind.value)).toEqual(["source.organizeImports"]);
    });

    it("offers one action, of kind source.organizeImports", () => {
        const actions = new ImportOrganizeCodeActionProvider().provideCodeActions(makeDocument());

        expect(actions).toHaveLength(1);
        expect(actions[0].kind?.value).toBe("source.organizeImports");
    });

    it("wires the action to the organize command, on the document it was asked about", () => {
        const document = makeDocument();

        const [action] = new ImportOrganizeCodeActionProvider().provideCodeActions(document);

        expect(action.command?.command).toBe("verseAutoImports.organizeImportsInDocument");
        expect(action.command?.arguments).toEqual([document]);
    });

    it("carries no edit of its own", () => {
        const [action] = new ImportOrganizeCodeActionProvider().provideCodeActions(makeDocument());

        expect(action.edit).toBeUndefined();
    });
});

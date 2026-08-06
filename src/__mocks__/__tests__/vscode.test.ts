import * as vscode from "vscode";

// Regression for #169: the mock Uri had no toString(), so every instance
// stringified to "[object Object]". Any test keying per-document state on
// uri.toString() - as DiagnosticsHandler, CommandsHandler,
// ImportCodeLensProvider and extension.ts all do in production - silently
// collapsed every document onto one key and passed for the wrong reason.
describe("mock vscode.Uri", () => {
    it("gives same-named files in different folders distinct keys", () => {
        const weapons = vscode.Uri.file("C:\\Project\\Content\\Weapons\\utils.verse");
        const ui = vscode.Uri.file("C:\\Project\\Content\\UI\\utils.verse");

        expect(weapons.toString()).not.toBe(ui.toString());
    });

    it("gives the same path the same key", () => {
        const first = vscode.Uri.file("C:\\Project\\Content\\device.verse");
        const second = vscode.Uri.file("C:\\Project\\Content\\device.verse");

        expect(first.toString()).toBe(second.toString());
    });

    it("renders a Windows path the way VS Code does", () => {
        expect(vscode.Uri.file("C:\\Project\\Content\\device.verse").toString()).toBe("file:///c%3A/Project/Content/device.verse");
    });

    it("renders a POSIX path with a single root slash", () => {
        expect(vscode.Uri.file("/home/user/Content/device.verse").toString()).toBe("file:///home/user/Content/device.verse");
    });

    it("keeps fsPath and scheme available alongside the key", () => {
        const uri = vscode.Uri.file("C:\\Project\\Content\\device.verse");

        expect(uri.fsPath).toBe("C:\\Project\\Content\\device.verse");
        expect(uri.scheme).toBe("file");
    });
});

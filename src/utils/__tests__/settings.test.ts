import * as vscode from "vscode";
import { settingsFor, writeSetting, writeTargetFor } from "../settings";

const getConfiguration = vscode.workspace.getConfiguration as unknown as jest.Mock;

/** The levels inspect() reports as carrying an explicit value. */
interface Levels {
    workspaceFolderValue?: unknown;
    workspaceValue?: unknown;
    globalValue?: unknown;
}

/**
 * A configuration whose inspect() reports exactly `levels`. Pass undefined for
 * the answer VS Code gives an unregistered key or a non-leaf section.
 */
function stubConfiguration(levels: Levels | undefined = {}): vscode.WorkspaceConfiguration {
    const config = {
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn().mockResolvedValue(undefined),
        inspect: jest.fn().mockReturnValue(levels === undefined ? undefined : { key: "verseAutoImports.behavior.importSyntax", ...levels }),
    };
    getConfiguration.mockReturnValue(config);
    return config as unknown as vscode.WorkspaceConfiguration;
}

afterEach(() => {
    getConfiguration.mockClear();
});

describe("settingsFor", () => {
    it("passes the resource through, so a folder value can resolve", () => {
        stubConfiguration();
        const uri = vscode.Uri.file("C:\\Project\\Content\\device.verse");

        settingsFor(uri);

        expect(getConfiguration).toHaveBeenCalledWith("verseAutoImports", uri);
    });

    it("asks for the window's configuration when the caller holds no resource", () => {
        stubConfiguration();

        settingsFor();

        expect(getConfiguration).toHaveBeenCalledWith("verseAutoImports", undefined);
    });
});

describe("writeTargetFor", () => {
    it("writes to the workspace folder when one already overrides the setting", () => {
        const config = stubConfiguration({ workspaceFolderValue: "dot", globalValue: "curly" });

        expect(writeTargetFor(config, "behavior.importSyntax", true)).toBe(vscode.ConfigurationTarget.WorkspaceFolder);
    });

    it("never picks the workspace folder for an unscoped configuration, which update rejects", () => {
        const config = stubConfiguration({ workspaceFolderValue: "dot" });

        expect(writeTargetFor(config, "behavior.importSyntax", false)).toBe(vscode.ConfigurationTarget.Global);
    });

    // A single-root workspace registers one model as both its workspace and its
    // folder configuration, so inspect() reports a folder value for a
    // window-scoped setting - and update() rejects a window setting aimed at a
    // folder. Trusting workspaceFolderValue alone throws at the user's click.
    it("never picks the workspace folder for a window-scoped setting, which update also rejects", () => {
        const config = stubConfiguration({ workspaceFolderValue: true, workspaceValue: true });

        expect(writeTargetFor(config, "experimental.useDigestFiles", true)).toBe(vscode.ConfigurationTarget.Workspace);
    });

    it("falls back to user settings when a window-scoped setting has only a folder value", () => {
        const config = stubConfiguration({ workspaceFolderValue: true });

        expect(writeTargetFor(config, "pathConversion.codeLensVisibility", true)).toBe(vscode.ConfigurationTarget.Global);
    });

    it("writes to the workspace when it holds the override, not over it", () => {
        const config = stubConfiguration({ workspaceValue: "dot", globalValue: "curly" });

        expect(writeTargetFor(config, "behavior.importSyntax", true)).toBe(vscode.ConfigurationTarget.Workspace);
    });

    it("prefers the folder over the workspace, matching how the two resolve", () => {
        const config = stubConfiguration({ workspaceFolderValue: "dot", workspaceValue: "curly" });

        expect(writeTargetFor(config, "behavior.importSyntax", true)).toBe(vscode.ConfigurationTarget.WorkspaceFolder);
    });

    it("writes to user settings when only they override the setting", () => {
        const config = stubConfiguration({ globalValue: "dot" });

        expect(writeTargetFor(config, "behavior.importSyntax", true)).toBe(vscode.ConfigurationTarget.Global);
    });

    it("writes to user settings when nothing overrides the setting", () => {
        const config = stubConfiguration({});

        expect(writeTargetFor(config, "behavior.importSyntax", true)).toBe(vscode.ConfigurationTarget.Global);
    });

    it("writes to user settings when inspect answers nothing at all", () => {
        const config = stubConfiguration(undefined);

        expect(writeTargetFor(config, "behavior.importSyntax", true)).toBe(vscode.ConfigurationTarget.Global);
    });

    // A false workspaceValue is an override like any other. Testing presence
    // with a truthiness check would read it as absent and write Global, which
    // is the shape of the defect for every boolean toggle the extension has.
    it("treats an explicit false as an override", () => {
        const config = stubConfiguration({ workspaceValue: false });

        expect(writeTargetFor(config, "general.autoImport", true)).toBe(vscode.ConfigurationTarget.Workspace);
    });
});

describe("writeSetting", () => {
    it("writes at the level the override already lives on", async () => {
        const config = stubConfiguration({ workspaceValue: false });

        await writeSetting("general.autoImport", true);

        expect(config.update).toHaveBeenCalledWith("general.autoImport", true, vscode.ConfigurationTarget.Workspace);
    });

    it("scopes the configuration it writes through to the resource it was given", async () => {
        stubConfiguration({});
        const uri = vscode.Uri.file("C:\\Project\\Content\\device.verse");

        await writeSetting("general.autoImport", false, uri);

        expect(getConfiguration).toHaveBeenCalledWith("verseAutoImports", uri);
    });
});

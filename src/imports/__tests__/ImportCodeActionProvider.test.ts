import * as vscode from "vscode";
import { ImportCodeActionProvider } from "../ImportCodeActionProvider";
import { ImportHandler } from "../ImportHandler";
import { ImportSuggestion } from "../../types";

/**
 * Regression for issue #135: the provider read quickFix.showDescriptions with a
 * fallback of true where package.json registers false. config.get returns the
 * registered default for a registered setting, so the fallback never reached
 * production - but the vscode mock returns the passed fallback, so the suite
 * exercised descriptions-on while every user saw them off.
 */
describe("ImportCodeActionProvider quick fix titles", () => {
    const suggestion = (overrides: Partial<ImportSuggestion> = {}): ImportSuggestion => ({
        importStatement: "using { /Fortnite.com/Devices }",
        source: "error_message",
        confidence: "high",
        description: "class from /Fortnite.com/Devices",
        ...overrides,
    });

    /** Drives the provider over one diagnostic and returns the action titles. */
    const titlesFor = async (suggestions: ImportSuggestion[]): Promise<string[]> => {
        const importHandler = { extractImportSuggestions: jest.fn().mockResolvedValue(suggestions) } as unknown as ImportHandler;
        const provider = new ImportCodeActionProvider({ appendLine: jest.fn() } as unknown as vscode.OutputChannel, importHandler);

        const actions = await provider.provideCodeActions(
            { uri: { toString: () => "file:///Project/Content/Scripts/device.verse" } } as unknown as vscode.TextDocument,
            {} as unknown as vscode.Range,
            { diagnostics: [{ message: "Unknown identifier `button_device`", range: { start: { line: 7 } } }] } as unknown as vscode.CodeActionContext,
            {} as unknown as vscode.CancellationToken,
        );

        return (actions ?? []).map((action) => action.title);
    };

    it("omits the description, matching the default package.json registers", async () => {
        expect(await titlesFor([suggestion()])).toEqual(["Add import: using { /Fortnite.com/Devices }"]);
    });

    it("omits the confidence indicator too", async () => {
        expect(await titlesFor([suggestion({ confidence: "low" })])).toEqual(["Add import: using { /Fortnite.com/Devices }"]);
    });

    // The writer reads behavior.importSyntax scoped to the document's folder,
    // so a labeller reading it window-scoped offers a title in one syntax and
    // inserts the other. The extractor must not be stubbed here: a stub would
    // supply the very statement under test.
    it("titles the action in the syntax the document's folder sets", async () => {
        const getConfiguration = vscode.workspace.getConfiguration as unknown as jest.Mock;
        const original = getConfiguration.getMockImplementation();
        const folder = "file:///Project/Content/Scripts/";
        getConfiguration.mockImplementation((_section: string, resource?: { toString(): string }) => ({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
                if (key === "behavior.importSyntax") {
                    return resource?.toString().startsWith(folder) ? "dot" : "curly";
                }
                return defaultValue;
            }),
            update: jest.fn().mockResolvedValue(undefined),
            inspect: jest.fn().mockReturnValue(undefined),
        }));

        try {
            const importHandler = new ImportHandler({ appendLine: jest.fn() } as unknown as vscode.OutputChannel);
            const provider = new ImportCodeActionProvider({ appendLine: jest.fn() } as unknown as vscode.OutputChannel, importHandler);

            const actions = await provider.provideCodeActions(
                { uri: { toString: () => `${folder}device.verse` } } as unknown as vscode.TextDocument,
                {} as unknown as vscode.Range,
                {
                    diagnostics: [{ message: "Unknown identifier `player`. Did you forget to specify using { /Verse.org/Simulation }", range: { start: { line: 7 } } }],
                } as unknown as vscode.CodeActionContext,
                {} as unknown as vscode.CancellationToken,
            );

            expect((actions ?? []).map((action) => action.title)).toEqual(["Add import: using. /Verse.org/Simulation"]);
            // The other half of the criterion: the statement handed to
            // addSingleImport is what gets written, so the title describes the
            // insertion only while these two agree.
            expect((actions ?? []).map((action) => action.command?.arguments?.[1])).toEqual(["using. /Verse.org/Simulation"]);
        } finally {
            getConfiguration.mockReset();
            if (original) {
                getConfiguration.mockImplementation(original);
            }
        }
    });

    it("shows both once the user turns descriptions on", async () => {
        const getConfiguration = vscode.workspace.getConfiguration as unknown as jest.Mock;
        const original = getConfiguration.getMockImplementation();
        getConfiguration.mockReturnValue({
            get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key === "quickFix.showDescriptions" ? true : defaultValue)),
            update: jest.fn().mockResolvedValue(undefined),
        });

        try {
            expect(await titlesFor([suggestion({ confidence: "medium" })])).toEqual(["[medium confidence] Add import: using { /Fortnite.com/Devices } (class from /Fortnite.com/Devices)"]);
        } finally {
            getConfiguration.mockReset();
            if (original) {
                getConfiguration.mockImplementation(original);
            }
        }
    });
});

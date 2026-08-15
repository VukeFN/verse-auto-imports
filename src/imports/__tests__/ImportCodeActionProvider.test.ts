import * as vscode from "vscode";
import { ImportCodeActionProvider } from "../ImportCodeActionProvider";
import { ImportHandler } from "../ImportHandler";
import { ImportSuggestion } from "../../types";

/**
 * Drives the provider over one diagnostic whose suggestions are given rather
 * than extracted, and returns the actions it produced.
 *
 * @param message The diagnostic text. It only has to classify as an unknown
 *   identifier - the stubbed handler, not the message, supplies the suggestions.
 */
const provideFor = async (suggestions: ImportSuggestion[], message = "Unknown identifier `button_device`"): Promise<vscode.CodeAction[]> => {
    const importHandler = { extractImportSuggestions: jest.fn().mockResolvedValue(suggestions) } as unknown as ImportHandler;
    const provider = new ImportCodeActionProvider({ appendLine: jest.fn() } as unknown as vscode.OutputChannel, importHandler);

    const actions = await provider.provideCodeActions(
        { uri: { toString: () => "file:///Project/Content/Scripts/device.verse" } } as unknown as vscode.TextDocument,
        {} as unknown as vscode.Range,
        { diagnostics: [{ message, range: { start: { line: 7 } } }] } as unknown as vscode.CodeActionContext,
        {} as unknown as vscode.CancellationToken,
    );

    return actions ?? [];
};

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

    const titlesFor = async (suggestions: ImportSuggestion[]): Promise<string[]> => (await provideFor(suggestions)).map((action) => action.title);

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

/**
 * `isPreferred` is what the editor applies on Ctrl+. Enter, so whichever
 * suggestion leads the list is the one a user takes without reading the rest.
 * The suggestions are stubbed here, so this pins only that the lead is what
 * gets preferred - which module leads is settled upstream, in the digest
 * manifest, and pinned by digestCollisionOrder.test.ts.
 */
describe("ImportCodeActionProvider preferred action", () => {
    const suggestion = (importStatement: string): ImportSuggestion => ({
        importStatement,
        source: "digest_lookup",
        confidence: "high",
        description: `class from ${importStatement}`,
    });

    it("prefers the leading suggestion and no other", async () => {
        const actions = await provideFor([suggestion("using { /Verse.org/SpatialMath }"), suggestion("using { /UnrealEngine.com/Temporary/SpatialMath }")], "Unknown identifier `vector3`");

        expect(actions.map((action) => action.isPreferred)).toEqual([true, false]);
        expect(actions[0].title).toBe("Add import: using { /Verse.org/SpatialMath }");
    });
});

/**
 * Regression for #365: the provider took a CancellationToken and never read
 * it, so a request superseded by the next cursor move still ran the async
 * extraction once per diagnostic - work whose result VS Code discards.
 */
describe("ImportCodeActionProvider cancellation", () => {
    const driveWith = async (isCancellationRequested: boolean, diagnosticCount: number) => {
        const extractImportSuggestions = jest.fn().mockResolvedValue([]);
        const provider = new ImportCodeActionProvider({ appendLine: jest.fn() } as unknown as vscode.OutputChannel, { extractImportSuggestions } as unknown as ImportHandler);
        const diagnostics = Array.from({ length: diagnosticCount }, () => ({
            message: "Unknown identifier `button_device`",
            range: { start: { line: 7 } },
        }));

        const actions = await provider.provideCodeActions(
            { uri: { toString: () => "file:///Project/Content/Scripts/device.verse" } } as unknown as vscode.TextDocument,
            {} as unknown as vscode.Range,
            { diagnostics } as unknown as vscode.CodeActionContext,
            { isCancellationRequested } as unknown as vscode.CancellationToken,
        );

        return { actions, extractImportSuggestions };
    };

    it("extracts nothing once the request is cancelled", async () => {
        const { actions, extractImportSuggestions } = await driveWith(true, 3);

        expect(extractImportSuggestions).not.toHaveBeenCalled();
        expect(actions).toBeUndefined();
    });

    it("extracts for every diagnostic while the request is live", async () => {
        const { extractImportSuggestions } = await driveWith(false, 3);

        expect(extractImportSuggestions).toHaveBeenCalledTimes(3);
    });
});

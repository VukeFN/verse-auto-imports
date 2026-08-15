import * as vscode from "vscode";
import { activate } from "../extension";
import { ImportCodeActionProvider } from "../imports/ImportCodeActionProvider";
import { ImportOrganizeCodeActionProvider } from "../imports/ImportOrganizeCodeActionProvider";
import { ModuleVisibilityCodeActionProvider } from "../visibility/ModuleVisibilityCodeActionProvider";

/**
 * Regression for #365: the quick fix providers were registered with no
 * metadata, and VS Code runs a provider that declares no kinds for every
 * code-action request of every kind - refactor menus, source-action menus,
 * on-type. ImportCodeActionProvider paid an async extraction per diagnostic
 * for requests it can never serve.
 */

/** The subset of ExtensionContext activate() touches. */
function makeContext(): { subscriptions: { dispose(): unknown }[]; workspaceState: unknown } {
    return {
        subscriptions: [],
        workspaceState: {
            get: jest.fn().mockReturnValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
            keys: jest.fn().mockReturnValue([]),
        },
    };
}

/**
 * The metadata activate() passed for the given provider class, or undefined
 * where it passed none - which is the defect this file pins.
 */
function metadataFor(providerClass: new (...args: never[]) => vscode.CodeActionProvider): vscode.CodeActionProviderMetadata | undefined {
    const calls = (vscode.languages.registerCodeActionsProvider as jest.Mock).mock.calls;
    const call = calls.find(([, provider]) => provider instanceof providerClass);
    if (!call) {
        throw new Error(`activate() registered no ${providerClass.name}`);
    }
    return call[2];
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
        inspect: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
    });
    activate(makeContext() as unknown as vscode.ExtensionContext);
});

describe("code action registrations declare the kinds they provide", () => {
    it("declares quick fixes for the import provider", () => {
        expect(metadataFor(ImportCodeActionProvider)?.providedCodeActionKinds).toEqual([vscode.CodeActionKind.QuickFix]);
    });

    it("declares quick fixes for the module visibility provider", () => {
        expect(metadataFor(ModuleVisibilityCodeActionProvider)?.providedCodeActionKinds).toEqual([vscode.CodeActionKind.QuickFix]);
    });

    // Already declared before #365, and the one registration where the
    // metadata is what routes the request rather than only filtering it.
    it("still declares the organize imports source action", () => {
        expect(metadataFor(ImportOrganizeCodeActionProvider)?.providedCodeActionKinds).toEqual([vscode.CodeActionKind.SourceOrganizeImports]);
    });

    it("leaves no code action provider registered without metadata", () => {
        const calls = (vscode.languages.registerCodeActionsProvider as jest.Mock).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const undeclared = calls.filter(([, , metadata]) => metadata?.providedCodeActionKinds === undefined).map(([, provider]) => provider.constructor.name);
        expect(undeclared).toEqual([]);
    });
});

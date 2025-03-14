import * as vscode from "vscode";
import { DiagnosticsHandler } from "./handlers/diagnosticsHandler";
import { ImportHandler } from "./handlers/importHandler";
import { CommandsHandler } from "./handlers/commandsHandler";
import { setupLogging } from "./utils/logging";
import { ImportCodeActionProvider } from "./providers/importCodeActionProvider";

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = setupLogging(context);
    outputChannel.appendLine("Verse Auto Imports is now active");

    const config = vscode.workspace.getConfiguration("verseAutoImports");
    const existingMappings = config.get<Record<string, string>>(
        "ambiguousImports",
        {}
    );

    if (Object.keys(existingMappings).length === 0) {
        outputChannel.appendLine("Setting default ambiguous import mappings");
        config.update(
            "ambiguousImports",
            {
                vector3: "/UnrealEngine.com/Temporary/SpatialMath",
                vector2: "/UnrealEngine.com/Temporary/SpatialMath",
                rotation: "/UnrealEngine.com/Temporary/SpatialMath",
            },
            vscode.ConfigurationTarget.Global
        );
    }

    outputChannel.appendLine("About to create handlers");
    const importHandler = new ImportHandler(outputChannel);
    const diagnosticsHandler = new DiagnosticsHandler(outputChannel);
    const commandsHandler = new CommandsHandler(outputChannel, importHandler);

    const delayMs = config.get<number>("diagnosticDelay", 1000);
    diagnosticsHandler.setDelay(delayMs);
    outputChannel.appendLine(`Initial delay set to ${delayMs}ms`);

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: "verse" },
            new ImportCodeActionProvider(outputChannel, importHandler)
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "verseAutoImports.addSingleImport",
            async (document: vscode.TextDocument, importStatement: string) => {
                await importHandler.addImportsToDocument(document, [
                    importStatement,
                ]);
                vscode.window.setStatusBarMessage(
                    `Added import: ${importStatement}`,
                    3000
                );
            }
        )
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("verseAutoImports.diagnosticDelay")
            ) {
                const newConfig =
                    vscode.workspace.getConfiguration("verseAutoImports");
                const newDelay = newConfig.get<number>("diagnosticDelay", 1000);
                diagnosticsHandler.setDelay(newDelay);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "verseAutoImports.optimizeImports",
            () => {
                commandsHandler.optimizeImports();
            }
        ),
        vscode.languages.onDidChangeDiagnostics(async (e) => {
            for (const uri of e.uris) {
                const diagnostics = vscode.languages.getDiagnostics(uri);

                try {
                    const document = await vscode.workspace.openTextDocument(
                        uri
                    );

                    if (document.languageId === "verse") {
                        const config =
                            vscode.workspace.getConfiguration(
                                "verseAutoImports"
                            );
                        const autoImportEnabled = config.get<boolean>(
                            "autoImport",
                            true
                        );

                        if (autoImportEnabled) {
                            await diagnosticsHandler.handle(document);
                        }
                    }
                } catch (error) {
                    outputChannel.appendLine(
                        `Error opening document ${uri.toString()}: ${error}`
                    );
                }
            }
        })
    );

    outputChannel.appendLine(
        "Verse Auto Imports extension activated successfully"
    );
}

export function deactivate() {}

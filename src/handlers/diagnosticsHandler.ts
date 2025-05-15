import * as vscode from "vscode";
import * as path from "path";
import { ImportHandler } from "./importHandler";
// import { ModuleHandler } from "./moduleHandler";
import { log } from "../utils/logging";

export class DiagnosticsHandler {
    private importHandler: ImportHandler;
    // private moduleHandler: ModuleHandler;
    private processingDocuments: Set<string> = new Set();
    private delayMs: number = 1000;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.importHandler = new ImportHandler(outputChannel);
        // this.moduleHandler = new ModuleHandler(outputChannel);
        log(
            this.outputChannel,
            `DiagnosticsHandler initialized with ${this.delayMs}ms delay`
        );
    }

    async handle(document: vscode.TextDocument) {
        const documentKey = path.basename(document.uri.fsPath);

        log(this.outputChannel, `Received diagnostics for ${documentKey}`);

        if (this.processingDocuments.has(documentKey)) {
            log(
                this.outputChannel,
                `⚠️ Already processing ${documentKey}, skipping`
            );
            return;
        }

        this.processingDocuments.add(documentKey);

        log(
            this.outputChannel,
            `⏱️ Waiting ${this.delayMs}ms before processing diagnostics for ${documentKey}`
        );

        setTimeout(async () => {
            try {
                const currentDiagnostics = vscode.languages.getDiagnostics(
                    document.uri
                );

                log(
                    this.outputChannel,
                    `Processing diagnostics for ${documentKey} after delay`
                );
                const importStatements = new Set<string>();

                for (const diagnostic of currentDiagnostics) {
                    const importStatement =
                        this.importHandler.extractImportStatement(
                            diagnostic.message
                        );
                    if (importStatement) {
                        log(
                            this.outputChannel,
                            `Adding import statement to collection: ${importStatement}`
                        );
                        importStatements.add(importStatement);
                        continue;
                    }

                    // await this.moduleHandler.handleModuleError(
                    //     diagnostic,
                    //     document
                    // );
                }

                if (importStatements.size > 0) {
                    log(
                        this.outputChannel,
                        `Total unique imports to add: ${importStatements.size}`
                    );
                    importStatements.forEach((imp) => {
                        log(this.outputChannel, `Will add: ${imp}`);
                    });

                    await this.importHandler.addImportsToDocument(
                        document,
                        Array.from(importStatements)
                    );
                    vscode.window.setStatusBarMessage(
                        `Added ${
                            importStatements.size
                        } imports to ${path.basename(document.uri.fsPath)}`,
                        3000
                    );
                }
            } catch (error) {
                log(
                    this.outputChannel,
                    `❌ Error processing diagnostics: ${error}`
                );
            } finally {
                this.processingDocuments.delete(documentKey);
                log(
                    this.outputChannel,
                    `🔄 Finished processing ${documentKey}`
                );
            }
        }, this.delayMs);
    }

    setDelay(delayMs: number) {
        this.delayMs = delayMs;
        log(
            this.outputChannel,
            `⚙️ Diagnostic processing delay set to ${delayMs}ms`
        );
    }
}

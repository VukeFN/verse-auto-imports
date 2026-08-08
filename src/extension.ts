import * as vscode from "vscode";
import { logger } from "./utils";
import { DiagnosticsHandler } from "./diagnostics";
import { ImportHandler, ImportPathConverter, ImportCodeActionProvider, ImportCodeLensProvider, ImportFormatter } from "./imports";
import { CommandsHandler, CommandsDependencies } from "./commands";
import { StatusBarHandler } from "./ui";
import { ProjectPathHandler } from "./project";
import { AssetsDigestParser, ProjectPathCache } from "./services";

/**
 * Reads the explicit user-set value of a setting, ignoring its registered
 * default. config.get cannot distinguish the two: for a registered setting it
 * returns the package.json default instead of the passed fallback.
 * Language-scoped values ("[verse]" blocks) are intentionally not consulted;
 * the config is fetched without a scope, so they have never applied here.
 */
function getExplicitSetting(config: vscode.WorkspaceConfiguration, key: string): number | undefined {
    const info = config.inspect<number>(key);
    return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

/**
 * Gets the configured debounce delay, handling backward compatibility with
 * the deprecated diagnosticDelay setting. Only explicit overrides are
 * considered so diagnosticDelay's registered default (1000) cannot shadow
 * autoImportDebounceDelay; an explicit autoImportDebounceDelay wins over an
 * explicit legacy value.
 */
function getConfiguredDebounceDelay(config: vscode.WorkspaceConfiguration): number {
    const explicitDelay = getExplicitSetting(config, "general.autoImportDebounceDelay");
    if (explicitDelay !== undefined) {
        return explicitDelay;
    }
    const explicitLegacyDelay = getExplicitSetting(config, "general.diagnosticDelay");
    if (explicitLegacyDelay !== undefined) {
        return explicitLegacyDelay;
    }
    return config.get<number>("general.autoImportDebounceDelay", 3000);
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize the logger
    logger.initialize(context);
    logger.info("Extension", "Verse Auto Imports is now active");

    // Get output channel for backward compatibility with handlers
    const outputChannel = logger.getUserChannel();

    const config = vscode.workspace.getConfiguration("verseAutoImports");
    const cacheEnabled = config.get<boolean>("cache.enableProjectCache", true);

    // Create core services
    logger.debug("Extension", "Creating handlers");
    const projectPathHandler = new ProjectPathHandler(outputChannel);
    const assetsDigestParser = new AssetsDigestParser(outputChannel, projectPathHandler);
    // Left undefined when the setting is off, so the dependency is absent in
    // fact and not only in type. Handing the cache to its consumers anyway is
    // what let the cache commands run with the feature disabled: they would
    // scan the project and write a cache that has no file watchers behind it,
    // so it is stale from the moment it is stored.
    const projectPathCache = cacheEnabled ? new ProjectPathCache(context, outputChannel, projectPathHandler) : undefined;

    // Create handlers and providers
    const importHandler = new ImportHandler(outputChannel, assetsDigestParser, context);
    const statusBarHandler = new StatusBarHandler(outputChannel);
    const diagnosticsHandler = new DiagnosticsHandler(outputChannel, importHandler, () => statusBarHandler.isSnoozeActive());
    const importPathConverter = new ImportPathConverter(outputChannel, projectPathCache);
    const importCodeLensProvider = new ImportCodeLensProvider(outputChannel);

    // Create CommandsHandler with all dependencies
    const commandsDeps: CommandsDependencies = {
        importHandler,
        statusBarHandler,
        importPathConverter,
        importCodeLensProvider,
        projectPathCache,
    };
    const commandsHandler = new CommandsHandler(commandsDeps);

    // Initialize assets digest cache asynchronously
    assetsDigestParser.ensureCachePopulated().catch((err) => {
        logger.warn("Extension", `Failed to initialize assets digest cache: ${err}`);
    });

    // Initialize project path cache asynchronously (if enabled)
    if (projectPathCache) {
        projectPathCache.initialize().catch((err) => {
            logger.warn("Extension", `Failed to initialize project path cache: ${err}`);
        });
    }

    // Set initial debounce delay (handles backward compat with deprecated setting)
    const delayMs = getConfiguredDebounceDelay(config);
    diagnosticsHandler.setDelay(delayMs);
    logger.info("Extension", `Initial debounce delay set to ${delayMs}ms`);

    // Register providers. The CodeLens provider is pushed alongside its
    // registration, not instead of it: registerCodeLensProvider disposes the
    // registration only, leaving the provider's own listeners and hide timers
    // live after deactivation.
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ language: "verse" }, new ImportCodeActionProvider(outputChannel, importHandler)),
        vscode.languages.registerCodeLensProvider({ language: "verse" }, importCodeLensProvider),
        importCodeLensProvider,
    );

    // Cancels any armed debounce timer on deactivation, so a pending
    // auto-import cannot edit a document after the extension is torn down.
    context.subscriptions.push(diagnosticsHandler);

    // Set up file watchers
    context.subscriptions.push(projectPathHandler.setupFileWatcher());
    context.subscriptions.push(assetsDigestParser.setupFileWatcher());
    if (projectPathCache) {
        context.subscriptions.push(projectPathCache.setupFileWatchers());
    }

    // Register all commands via CommandsHandler
    commandsHandler.registerAll(context);

    // Register hover provider for CodeLens visibility
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: "verse" },
            {
                provideHover(document, position) {
                    const config = vscode.workspace.getConfiguration("verseAutoImports");
                    if (!config.get<boolean>("pathConversion.enableCodeLens", true)) {
                        return null;
                    }

                    const line = document.lineAt(position.line);
                    const text = line.text.trim();
                    const nextLineText = position.line + 1 < document.lineCount ? document.lineAt(position.line + 1).text : undefined;

                    if (ImportFormatter.isModuleImport(text, nextLineText)) {
                        importCodeLensProvider.setHoverState(document.uri.toString(), true, position.line);
                    } else {
                        importCodeLensProvider.setHoverState(document.uri.toString(), false);
                    }
                    return null;
                },
            },
        ),
    );

    // Register the status bar handler for disposal (clears the snooze timer
    // and disposes the status bar item on deactivation).
    context.subscriptions.push(statusBarHandler);

    // Configuration change listener for debounce delay
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("verseAutoImports.general.diagnosticDelay") || event.affectsConfiguration("verseAutoImports.general.autoImportDebounceDelay")) {
                const newConfig = vscode.workspace.getConfiguration("verseAutoImports");
                const finalDelay = getConfiguredDebounceDelay(newConfig);
                diagnosticsHandler.setDelay(finalDelay);
                logger.info("Extension", `Debounce delay updated to ${finalDelay}ms`);
            }
        }),
    );

    // Configuration change listener for the project path cache toggle. Whether
    // the cache exists at all is decided once, here in activate(), so a toggle
    // cannot take effect until the window reloads - say so rather than leaving
    // the user with a setting that silently does nothing.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (!event.affectsConfiguration("verseAutoImports.cache.enableProjectCache")) {
                return;
            }
            const choice = await vscode.window.showInformationMessage("Reload the window for the Verse Auto Imports project path cache setting to take effect.", "Reload Window");
            if (choice === "Reload Window") {
                await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        }),
    );

    // Document save listener for import spacing
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (document.languageId === "verse") {
                const config = vscode.workspace.getConfiguration("verseAutoImports");
                const emptyLinesAfterImports = config.get<number>("behavior.emptyLinesAfterImports", 1);
                if (emptyLinesAfterImports >= 0) {
                    await importHandler.ensureEmptyLinesAfterImports(document);
                }
            }
        }),
    );

    // Diagnostics change listener for auto-import
    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(async (e) => {
            for (const uri of e.uris) {
                if (!DiagnosticsHandler.shouldProcessUri(uri)) {
                    continue;
                }
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    if (document.languageId === "verse") {
                        const config = vscode.workspace.getConfiguration("verseAutoImports");
                        // The snooze is in-memory state, not a setting, so it
                        // is checked here rather than read back from config.
                        // This is only the cheap early exit; the authoritative
                        // check is in the debounce callback, which has to
                        // re-check because a snooze can start after a timer
                        // has already been scheduled.
                        if (config.get<boolean>("general.autoImport", true) && !statusBarHandler.isSnoozeActive()) {
                            await diagnosticsHandler.handle(document);
                        }
                    }
                } catch (error) {
                    logger.error("Extension", `Error opening document ${uri.toString()}`, error);
                }
            }
        }),
    );

    logger.info("Extension", "Verse Auto Imports extension activated successfully");
}

export function deactivate() {
    logger.info("Extension", "Verse Auto Imports extension deactivated");
}

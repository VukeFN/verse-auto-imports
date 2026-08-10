import * as vscode from "vscode";
import { logger, collectEnvironment, formatHostSummary, readSessionState } from "./utils";
import { DiagnosticsHandler } from "./diagnostics";
import { ImportHandler, ImportPathConverter, ImportCodeActionProvider, ImportCodeLensProvider, ImportFormatter } from "./imports";
import { CommandsHandler, CommandsDependencies } from "./commands";
import { StatusBarHandler } from "./ui";
import { ProjectPathHandler } from "./project";
import { AssetsDigestParser, ProjectPathCache } from "./services";
import { ModuleVisibilityCodeActionProvider, ModuleVisibilityWriter } from "./visibility";

/**
 * The project path cache toggle, and the default the two reads of it must
 * agree on: activation captures the value, and the configuration listener
 * compares against that capture to decide whether a reload is really needed.
 */
const CACHE_SETTING = "cache.enableProjectCache";
const CACHE_SETTING_DEFAULT = true;

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
 * The debounce delay in milliseconds, honouring the deprecated
 * diagnosticDelay setting. Only explicit overrides are considered, so
 * diagnosticDelay's registered default (1000) cannot shadow
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

/**
 * Builds the handlers, registers every provider, watcher, command and listener
 * on the extension context, and starts the two caches.
 *
 * Whether the project path cache exists at all is decided once, here, from the
 * setting as it reads at activation. Nothing downstream can turn it on later.
 */
export function activate(context: vscode.ExtensionContext) {
    logger.initialize(context);

    // Record which build and host this is before anything else logs, so an
    // exported session can be tied back to a specific vsix. The settings go to
    // DEBUG rather than INFO: they belong in the export, not in the channel the
    // user reads. Both reach the export buffer, which stores every level.
    const environment = collectEnvironment(context);
    const sessionState = readSessionState();
    logger.setEnvironment(environment);
    logger.info("Extension", `Verse Auto Imports ${environment.extensionVersion} is now active (${formatHostSummary(environment, sessionState)})`);
    logger.debug("Extension", "Settings at activation", sessionState.settings);

    // Handlers take this channel but log through the `logger` singleton. The
    // parameter survives from before the logger existed and is threaded down
    // the whole handler tree; the only thing anyone does with it at the end is
    // StatusBarHandler showing the channel.
    const outputChannel = logger.getUserChannel();

    const config = vscode.workspace.getConfiguration("verseAutoImports");
    const cacheEnabled = config.get<boolean>(CACHE_SETTING, CACHE_SETTING_DEFAULT);

    logger.debug("Extension", "Creating handlers");
    const projectPathHandler = new ProjectPathHandler(outputChannel);
    const assetsDigestParser = new AssetsDigestParser(outputChannel, projectPathHandler);
    // Left undefined when the setting is off, so the dependency is absent in
    // fact and not only in type. Handing the cache to its consumers anyway is
    // what let the cache commands run with the feature disabled: they would
    // scan the project and write a cache that has no file watchers behind it,
    // so it is stale from the moment it is stored.
    const projectPathCache = cacheEnabled ? new ProjectPathCache(context, outputChannel, projectPathHandler) : undefined;

    const importHandler = new ImportHandler(outputChannel, assetsDigestParser, context);
    const statusBarHandler = new StatusBarHandler(outputChannel);
    const diagnosticsHandler = new DiagnosticsHandler(outputChannel, importHandler, () => statusBarHandler.isSnoozeActive());
    const importPathConverter = new ImportPathConverter(outputChannel, projectPathCache);
    const importCodeLensProvider = new ImportCodeLensProvider(outputChannel);
    const moduleVisibilityWriter = new ModuleVisibilityWriter(outputChannel, projectPathHandler);

    const commandsDeps: CommandsDependencies = {
        importHandler,
        statusBarHandler,
        importPathConverter,
        importCodeLensProvider,
        moduleVisibilityWriter,
        projectPathCache,
    };
    const commandsHandler = new CommandsHandler(commandsDeps);

    // Both caches populate off the activation path: a synchronous scan here
    // would delay every other registration below.
    assetsDigestParser.ensureCachePopulated().catch((err) => {
        logger.warn("Extension", `Failed to initialize assets digest cache: ${err}`);
    });

    if (projectPathCache) {
        projectPathCache.initialize().catch((err) => {
            logger.warn("Extension", `Failed to initialize project path cache: ${err}`);
        });
    } else {
        // Nothing loads or invalidates a stored cache while the feature is off,
        // and the Clear Project Path Cache command is guarded off with it, so a
        // payload from an earlier session would sit in workspace storage with
        // no route left to remove it. Say so when one is dropped: this is the
        // only destructive thing activation does.
        ProjectPathCache.clearPersistedCache(context)
            .then((dropped) => {
                if (dropped) {
                    logger.info("Extension", "Dropped the stored project path cache: the cache is disabled, so nothing would load or invalidate it");
                }
            })
            .catch((err) => {
                logger.warn("Extension", `Failed to drop the stored project path cache: ${err}`);
            });
    }

    const delayMs = getConfiguredDebounceDelay(config);
    diagnosticsHandler.setDelay(delayMs);
    logger.info("Extension", `Initial debounce delay set to ${delayMs}ms`);

    // The CodeLens provider is pushed alongside its registration, not instead
    // of it: registerCodeLensProvider disposes the registration only, leaving
    // the provider's own listeners and hide timers live after deactivation.
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ language: "verse" }, new ImportCodeActionProvider(outputChannel, importHandler)),
        vscode.languages.registerCodeActionsProvider({ language: "verse" }, new ModuleVisibilityCodeActionProvider()),
        vscode.languages.registerCodeLensProvider({ language: "verse" }, importCodeLensProvider),
        importCodeLensProvider,
    );

    // Cancels any armed debounce timer on deactivation, so a pending
    // auto-import cannot edit a document after the extension is torn down.
    context.subscriptions.push(diagnosticsHandler);

    context.subscriptions.push(projectPathHandler.setupFileWatcher());
    context.subscriptions.push(assetsDigestParser.setupFileWatcher());
    if (projectPathCache) {
        context.subscriptions.push(projectPathCache.setupFileWatchers());
    }

    commandsHandler.registerAll(context);

    // The hover provider exists only to drive CodeLens visibility: it always
    // returns null, and its work is the setHoverState call.
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

    // Disposal is what removes the handler's own configuration listener, which
    // would otherwise outlive the extension; it also stops the snooze countdown
    // and disposes the status bar item.
    context.subscriptions.push(statusBarHandler);

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

    // The cache is constructed once at activation, so toggling the setting
    // cannot take effect until the window reloads - say so rather than leaving
    // the user with a setting that silently does nothing.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (!event.affectsConfiguration(`verseAutoImports.${CACHE_SETTING}`)) {
                return;
            }
            // A change back to what activation captured needs no reload; the
            // window already behaves the way the setting now reads.
            const newValue = vscode.workspace.getConfiguration("verseAutoImports").get<boolean>(CACHE_SETTING, CACHE_SETTING_DEFAULT);
            if (newValue === cacheEnabled) {
                return;
            }
            const choice = await vscode.window.showInformationMessage("Reload the window for the Verse Auto Imports project path cache setting to take effect.", "Reload Window");
            if (choice === "Reload Window") {
                await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        }),
    );

    // Import spacing has to be applied *during* the save, not after it: an
    // edit applied once the save has completed makes the tab dirty again the
    // instant the user saves, and only a second save converges. waitUntil hands
    // the edits to VS Code, which applies them before writing the file, so the
    // saved content is already correct.
    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument((event) => {
            if (event.document.languageId !== "verse") {
                return;
            }
            // waitUntil is only accepted while the listener is on the stack, so
            // the edits are computed synchronously. Nothing here may throw
            // either: a save participant that throws blocks the save.
            try {
                const edits = importHandler.computeEmptyLinesAfterImportsEdits(event.document);
                if (edits.length > 0) {
                    event.waitUntil(Promise.resolve(edits));
                }
            } catch (error) {
                logger.error("Extension", `Error computing import spacing on save: ${error}`, error);
            }
        }),
    );

    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(async (e) => {
            // Read once per event, and snapshot what the user has on screen only
            // when the scope actually restricts something - this listener runs
            // on every compile pass, and the default path must not pay for a
            // feature it does not use.
            const scope = vscode.workspace.getConfiguration("verseAutoImports").get<string>("general.autoImportScope", "allFiles");
            const visibility = !DiagnosticsHandler.scopeRestrictsDocuments(scope)
                ? { openUris: [] }
                : {
                      // Open tabs, never workspace.textDocuments - see
                      // DiagnosticsHandler.isUriInScope for why that list
                      // cannot answer this question.
                      //
                      // Snapshotted when the diagnostics arrived, not per uri:
                      // that is the moment the scope describes, and the loop
                      // awaits, so a per-uri read would drift.
                      openUris: vscode.window.tabGroups.all.flatMap((group) =>
                          group.tabs.filter((tab): tab is vscode.Tab & { input: vscode.TabInputText } => tab.input instanceof vscode.TabInputText).map((tab) => tab.input.uri.toString()),
                      ),
                      activeUri: vscode.window.activeTextEditor?.document.uri.toString(),
                  };

            for (const uri of e.uris) {
                if (!DiagnosticsHandler.shouldProcessUri(uri)) {
                    continue;
                }
                // Gate before openTextDocument, never after: the open is itself
                // what pulls a file the user never opened into the workspace.
                if (!DiagnosticsHandler.isUriInScope(uri, scope, visibility)) {
                    logger.trace("Extension", `Skipping ${uri.toString()}: outside the ${scope} auto-import scope`);
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

/**
 * Logs the shutdown. Teardown itself belongs to the disposables registered on
 * the extension context during activation, not here.
 */
export function deactivate() {
    logger.info("Extension", "Verse Auto Imports extension deactivated");
}

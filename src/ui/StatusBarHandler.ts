import * as vscode from "vscode";
import { logger } from "../utils";

interface QuickPickItemWithAction extends vscode.QuickPickItem {
    action?: () => void | Promise<void>;
}

const STATUS_BAR_PRIORITY = 100;
const SNOOZE_INTERVAL_MS = 1000;
const MS_PER_MINUTE = 60000;

function toggleIcon(enabled: boolean, label: string): string {
    return enabled ? `$(check) ${label}` : `$(blank) ${label}`;
}

export class StatusBarHandler {
    private statusBarItem: vscode.StatusBarItem;
    private snoozeEndTime: number | null = null;
    private snoozeInterval: NodeJS.Timeout | null = null;
    private readonly configListener: vscode.Disposable;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
        this.statusBarItem.command = "verseAutoImports.showStatusMenu";
        this.statusBarItem.name = "Verse Auto Imports";

        this.updateDisplay();
        this.statusBarItem.show();

        // Listen for configuration changes to update status bar
        this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("verseAutoImports")) {
                // A snooze does not touch the setting, so this only fires when
                // the user turns auto import on themselves mid-snooze. Take
                // that as "imports now, please" and drop the snooze. The raw
                // field, not isSnoozeActive(): the question here is whether
                // there is any snooze to clear, an expired one included.
                if (event.affectsConfiguration("verseAutoImports.general.autoImport") && this.snoozeEndTime !== null) {
                    const config = vscode.workspace.getConfiguration("verseAutoImports");
                    const autoImportEnabled = config.get<boolean>("general.autoImport", true);

                    if (autoImportEnabled) {
                        // User manually enabled auto imports - cancel the snooze silently
                        this.cancelSnoozeSilently();
                    }
                }
                this.updateDisplay();
            }
        });
    }

    /**
     * Whether auto imports are currently suppressed by a snooze. Snooze state
     * is deliberately in-memory only: it is ephemeral and time-boxed, so it
     * must not outlive the extension host. Persisting it (or mirroring it into
     * user settings) is what could leave auto imports off forever after a
     * reload mid-snooze.
     */
    isSnoozeActive(): boolean {
        return this.snoozeEndTime !== null && Date.now() < this.snoozeEndTime;
    }

    updateDisplay(): void {
        if (this.isSnoozeActive()) {
            // Snooze is active - show text with countdown
            const remaining = this.getRemainingTime();
            this.statusBarItem.text = `Verse Auto Imports (${remaining})`;
        } else {
            // Normal state - just show text
            this.statusBarItem.text = "Verse Auto Imports";
        }
    }

    private getRemainingTime(): string {
        if (this.snoozeEndTime === null) return "0:00";

        const now = Date.now();
        const remaining = Math.max(0, this.snoozeEndTime - now);
        const minutes = Math.floor(remaining / MS_PER_MINUTE);
        const seconds = Math.floor((remaining % MS_PER_MINUTE) / 1000);

        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    async showMenu(): Promise<void> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const autoImportEnabled = config.get<boolean>("general.autoImport", true);
        const preserveLocations = config.get<boolean>("behavior.preserveImportLocations", true);
        const useDigestFiles = config.get<boolean>("experimental.useDigestFiles", false);
        const importSyntax = config.get<string>("behavior.importSyntax", "curly");
        const showCodeLens = config.get<boolean>("pathConversion.enableCodeLens", true);
        const codeLensVisibility = config.get<string>("pathConversion.codeLensVisibility", "hover");
        const sortImports = config.get<boolean>("behavior.sortImportsAlphabetically", true);
        const importGrouping = config.get<string>("behavior.importGrouping", "none");

        const items: QuickPickItemWithAction[] = [];

        // ── Quick Actions ──
        items.push({
            label: "Quick Actions",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: "$(file-code) Optimize Imports",
            description: "Sort and organize imports in current file",
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.optimizeImports");
            },
        });

        // ── General ──
        items.push({
            label: "General",
            kind: vscode.QuickPickItemKind.Separator,
        });

        // A snooze no longer flips the setting, so the row would otherwise
        // report "Enabled" while imports are suppressed.
        let autoImportDescription: string;
        if (!autoImportEnabled) {
            autoImportDescription = "Disabled";
        } else if (this.isSnoozeActive()) {
            autoImportDescription = `Snoozed (${this.getRemainingTime()})`;
        } else {
            autoImportDescription = "Enabled";
        }

        items.push({
            label: toggleIcon(autoImportEnabled, "Auto Import"),
            description: autoImportDescription,
            action: async () => {
                await config.update("general.autoImport", !autoImportEnabled, vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", `Auto import toggled: ${!autoImportEnabled}`);
            },
        });

        // Snooze section
        if (this.isSnoozeActive()) {
            const remaining = this.getRemainingTime();

            items.push({
                label: "$(add) Add 5 Minutes",
                description: `${remaining} remaining`,
                action: () => {
                    this.extendSnooze(5);
                },
            });

            items.push({
                label: "$(close) Cancel Snooze",
                description: "Resume auto imports immediately",
                action: () => {
                    this.cancelSnooze();
                },
            });
        } else {
            items.push({
                label: "$(clock) Snooze",
                description: "Turn off auto imports for 5 mins",
                action: () => {
                    this.startSnooze(5);
                },
            });
        }

        // ── Import Behavior ──
        items.push({
            label: "Import Behavior",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(preserveLocations, "Preserve Import Locations"),
            description: preserveLocations ? "Keep imports in place" : "Consolidate at top",
            action: async () => {
                await config.update("behavior.preserveImportLocations", !preserveLocations, vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", `Preserve import locations toggled: ${!preserveLocations}`);
            },
        });

        items.push({
            label: toggleIcon(sortImports, "Sort Imports Alphabetically"),
            description: sortImports ? "Sorted A-Z" : "Original order preserved",
            action: async () => {
                await config.update("behavior.sortImportsAlphabetically", !sortImports, vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", `Sort imports alphabetically toggled: ${!sortImports}`);
            },
        });

        // Import Grouping option
        let groupingLabel = "";
        let groupingDescription = "";

        switch (importGrouping) {
            case "none":
                groupingLabel = "$(list-unordered) Import Grouping: None";
                groupingDescription = "No grouping";
                break;
            case "digestFirst":
                groupingLabel = "$(list-ordered) Import Grouping: Digest First";
                groupingDescription = "Digest imports, then local";
                break;
            case "localFirst":
                groupingLabel = "$(list-ordered) Import Grouping: Local First";
                groupingDescription = "Local imports, then digest";
                break;
        }

        items.push({
            label: `${groupingLabel} $(chevron-right)`,
            description: groupingDescription,
            action: async () => {
                await this.showImportGroupingMenu();
            },
        });

        // Import Syntax checkbox
        const isDotSyntax = importSyntax === "dot";
        items.push({
            label: toggleIcon(isDotSyntax, "Dot Syntax (using.)"),
            description: isDotSyntax ? "using. /Path" : "using { /Path }",
            action: async () => {
                const newSyntax = isDotSyntax ? "curly" : "dot";
                await config.update("behavior.importSyntax", newSyntax, vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", `Import syntax changed to: ${newSyntax}`);
            },
        });

        // ── Path Conversion ──
        items.push({
            label: "Path Conversion",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(showCodeLens, "Path Conversion Helper"),
            description: showCodeLens ? "Enabled" : "Disabled",
            action: async () => {
                await config.update("pathConversion.enableCodeLens", !showCodeLens, vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", `Path conversion CodeLens toggled: ${!showCodeLens}`);
            },
        });

        // CodeLens Visibility submenu
        const visibilityLabel = codeLensVisibility === "hover" ? "Hover Only" : "Always Visible";
        items.push({
            label: `$(list-unordered) CodeLens Visibility: ${visibilityLabel} $(chevron-right)`,
            description: "When to show path conversion options",
            action: async () => {
                await this.showCodeLensVisibilityMenu();
            },
        });

        // ── Experimental ──
        items.push({
            label: "Experimental",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(useDigestFiles, "Use Digest Files"),
            description: useDigestFiles ? "Enabled" : "Disabled",
            action: async () => {
                await config.update("experimental.useDigestFiles", !useDigestFiles, vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", `Use digest files toggled: ${!useDigestFiles}`);
            },
        });

        // ── Utilities ──
        items.push({
            label: "Utilities",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: "$(output) View Output Logs",
            description: "Open extension output channel",
            action: () => {
                this.outputChannel.show();
            },
        });

        items.push({
            label: "$(export) Export Debug Logs",
            description: `${logger.getBufferSize()} entries`,
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.exportDebugLogs");
            },
        });

        items.push({
            label: "$(settings-gear) Open Extension Settings",
            description: "View all Verse Auto Imports settings",
            action: async () => {
                await vscode.commands.executeCommand("workbench.action.openSettings", "verseAutoImports");
            },
        });

        // Show the menu
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Verse Auto Imports - Quick Actions",
            matchOnDescription: true,
        });

        // Execute the action if an item was selected
        if (selected?.action) {
            try {
                await selected.action();
            } catch (error) {
                logger.error("StatusBarHandler", `Menu action failed: ${error}`);
                vscode.window.showErrorMessage(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async showImportGroupingMenu(): Promise<void> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const currentGrouping = config.get<string>("behavior.importGrouping", "none");

        const items: QuickPickItemWithAction[] = [];

        // Add back option
        items.push({
            label: "$(arrow-left) Back to main menu",
            description: "",
            action: async () => {
                await this.showMenu();
            },
        });

        // Separator
        items.push({
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
        });

        // None option
        items.push({
            label: toggleIcon(currentGrouping === "none", "No Grouping"),
            description: "All imports mixed together (default)",
            action: async () => {
                await config.update("behavior.importGrouping", "none", vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", "Import grouping changed to: none");
                vscode.window.showInformationMessage("Import grouping disabled");
            },
        });

        // Digest First option
        items.push({
            label: toggleIcon(currentGrouping === "digestFirst", "Digest First"),
            description: "Digest imports (/Verse.org, /Fortnite.com, /UnrealEngine.com), then local imports",
            action: async () => {
                await config.update("behavior.importGrouping", "digestFirst", vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", "Import grouping changed to: digestFirst");
                vscode.window.showInformationMessage("Import grouping: Digest imports first");
            },
        });

        // Local First option
        items.push({
            label: toggleIcon(currentGrouping === "localFirst", "Local First"),
            description: "Local imports, then digest imports",
            action: async () => {
                await config.update("behavior.importGrouping", "localFirst", vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", "Import grouping changed to: localFirst");
                vscode.window.showInformationMessage("Import grouping: Local imports first");
            },
        });

        // Show the submenu
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Select Import Grouping Option",
            matchOnDescription: true,
        });

        // Execute the action if an item was selected
        if (selected?.action) {
            try {
                await selected.action();
            } catch (error) {
                logger.error("StatusBarHandler", `Menu action failed: ${error}`);
                vscode.window.showErrorMessage(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async showCodeLensVisibilityMenu(): Promise<void> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        const currentVisibility = config.get<string>("pathConversion.codeLensVisibility", "hover");

        const items: QuickPickItemWithAction[] = [];

        // Add back option
        items.push({
            label: "$(arrow-left) Back to main menu",
            description: "",
            action: async () => {
                await this.showMenu();
            },
        });

        // Separator
        items.push({
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
        });

        // Hover Only option
        items.push({
            label: toggleIcon(currentVisibility === "hover", "Hover Only"),
            description: "Show only when hovering over imports (default)",
            action: async () => {
                await config.update("pathConversion.codeLensVisibility", "hover", vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", "CodeLens visibility changed to: hover");
                vscode.window.showInformationMessage("CodeLens visibility: Hover only");
            },
        });

        // Always Visible option
        items.push({
            label: toggleIcon(currentVisibility === "always", "Always Visible"),
            description: "Always show above import statements",
            action: async () => {
                await config.update("pathConversion.codeLensVisibility", "always", vscode.ConfigurationTarget.Global);
                logger.debug("StatusBarHandler", "CodeLens visibility changed to: always");
                vscode.window.showInformationMessage("CodeLens visibility: Always visible");
            },
        });

        // Show the submenu
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Select CodeLens Visibility Option",
            matchOnDescription: true,
        });

        // Execute the action if an item was selected
        if (selected?.action) {
            try {
                await selected.action();
            } catch (error) {
                logger.error("StatusBarHandler", `Menu action failed: ${error}`);
                vscode.window.showErrorMessage(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    startSnooze(minutes: number): void {
        logger.debug("StatusBarHandler", `Starting snooze for ${minutes} minutes`);

        // Clear any existing snooze first so re-invoking (e.g. the command
        // palette while already snoozed) cannot orphan a running interval.
        this.clearSnoozeState();

        // Set snooze end time. This is the whole of the snooze state: the
        // auto-import path consults isSnoozeActive(), and no user setting is
        // touched, so nothing can survive the extension host and leave auto
        // imports disabled.
        this.snoozeEndTime = Date.now() + minutes * MS_PER_MINUTE;

        // Start countdown interval
        this.snoozeInterval = setInterval(() => {
            if (this.snoozeEndTime && Date.now() >= this.snoozeEndTime) {
                this.endSnooze();
            } else {
                this.updateDisplay();
            }
        }, SNOOZE_INTERVAL_MS);

        // Update immediately
        this.updateDisplay();

        vscode.window.showInformationMessage(`Auto imports snoozed for ${minutes} minutes`);
    }

    private extendSnooze(minutes: number): void {
        if (!this.isSnoozeActive()) return;

        logger.debug("StatusBarHandler", `Extending snooze by ${minutes} minutes`);
        this.snoozeEndTime += minutes * MS_PER_MINUTE;
        this.updateDisplay();

        vscode.window.showInformationMessage(`Snooze extended by ${minutes} minutes`);
    }

    private clearSnoozeState(): void {
        this.snoozeEndTime = null;
        if (this.snoozeInterval) {
            clearInterval(this.snoozeInterval);
            this.snoozeInterval = null;
        }
    }

    cancelSnooze(): void {
        logger.debug("StatusBarHandler", "Cancelling snooze");
        this.clearSnoozeState();

        this.updateDisplay();
        vscode.window.showInformationMessage("Auto imports resumed");
    }

    private cancelSnoozeSilently(): void {
        if (this.snoozeEndTime === null) {
            return;
        }

        this.clearSnoozeState();
        logger.debug("StatusBarHandler", "Snooze cancelled due to manual auto import enable");
    }

    private endSnooze(): void {
        logger.debug("StatusBarHandler", "Snooze timer expired");
        this.clearSnoozeState();

        this.updateDisplay();
        vscode.window.showInformationMessage("Auto imports resumed automatically");
    }

    dispose(): void {
        if (this.snoozeInterval) {
            clearInterval(this.snoozeInterval);
        }
        this.configListener.dispose();
        this.statusBarItem.dispose();
    }
}

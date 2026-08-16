import * as vscode from "vscode";
import { logger, activeResource, settingsFor, writeSetting } from "../utils";

interface QuickPickItemWithAction extends vscode.QuickPickItem {
    /** What selecting the item does. Separators and labels carry none. */
    action?: () => void | Promise<void>;
}

const STATUS_BAR_PRIORITY = 100;
const SNOOZE_INTERVAL_MS = 1000;
const MS_PER_MINUTE = 60000;

function toggleIcon(enabled: boolean, label: string): string {
    return enabled ? `$(check) ${label}` : `$(blank) ${label}`;
}

/**
 * The extension's status bar item, the quick-pick menu behind it, and the
 * snooze that suppresses auto-import for a few minutes at a time.
 *
 * Disposable, and registered as one during activation: an armed snooze holds a
 * repeating interval that would otherwise keep running after teardown.
 */
export class StatusBarHandler {
    private statusBarItem: vscode.StatusBarItem;
    private snoozeEndTime: number | null = null;
    private snoozeInterval: NodeJS.Timeout | null = null;
    private readonly configListener: vscode.Disposable;

    constructor(private outputChannel: vscode.OutputChannel) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
        // Clicking the item invokes this id, which CommandsHandler registers.
        // The registration is pinned by the integration suite, this literal by
        // nothing: change it alone and the item stops responding to clicks.
        this.statusBarItem.command = "verseAutoImports.showStatusMenu";
        this.statusBarItem.name = "Verse Auto Imports";
        // The text below is icon-only, so the tooltip carries the hover
        // identification and accessibilityInformation the screen-reader label.
        this.statusBarItem.tooltip = "Verse Auto Imports";
        this.statusBarItem.accessibilityInformation = { label: "Verse Auto Imports" };

        this.updateDisplay();
        this.statusBarItem.show();

        this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("verseAutoImports")) {
                // A snooze does not touch the setting, so this only fires when
                // the user turns auto import on themselves mid-snooze. Take
                // that as "imports now, please" and drop the snooze. The raw
                // field, not isSnoozeActive(): the question here is whether
                // there is any snooze to clear, an expired one included.
                if (event.affectsConfiguration("verseAutoImports.general.autoImport") && this.snoozeEndTime !== null) {
                    const config = settingsFor();
                    const autoImportEnabled = config.get<boolean>("general.autoImport", true);

                    if (autoImportEnabled) {
                        this.cancelSnoozeSilently();
                    }
                }
                this.updateDisplay();
            }
        });
    }

    /**
     * Whether auto imports are currently suppressed by a snooze. Callers weigh
     * this against the autoImport setting; a snooze suppresses imports without
     * touching it, so neither answers the question alone.
     *
     * Snooze state is deliberately in-memory only: it is ephemeral and
     * time-boxed, so it must not outlive the extension host. Persisting it (or
     * mirroring it into user settings) is what could leave auto imports off
     * forever after a reload mid-snooze.
     */
    isSnoozeActive(): boolean {
        return this.snoozeEndTime !== null && Date.now() < this.snoozeEndTime;
    }

    updateDisplay(): void {
        // The icon id resolves through contributes.icons in package.json
        // (media/icon.woff); rename it there and the item renders blank.
        if (this.isSnoozeActive()) {
            const remaining = this.getRemainingTime();
            this.statusBarItem.text = `$(verse-imports-icon) ${remaining}`;
        } else {
            this.statusBarItem.text = "$(verse-imports-icon)";
        }
    }

    /** The time left on the snooze as `m:ss`, or "0:00" once it has run out. */
    private getRemainingTime(): string {
        if (this.snoozeEndTime === null) return "0:00";

        const now = Date.now();
        const remaining = Math.max(0, this.snoozeEndTime - now);
        const minutes = Math.floor(remaining / MS_PER_MINUTE);
        const seconds = Math.floor((remaining % MS_PER_MINUTE) / 1000);

        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    /**
     * Shows the quick-pick menu and runs whatever the user picked. Every row
     * reads its state from configuration at the moment the menu opens, so a
     * setting changed elsewhere is reflected the next time it is shown.
     */
    async showMenu(): Promise<void> {
        // The rows describe what will happen to the file in front of the user,
        // so the settings behind them are read for that file.
        const resource = activeResource();
        const config = settingsFor(resource);
        const autoImportEnabled = config.get<boolean>("general.autoImport", true);
        const preserveLocations = config.get<boolean>("behavior.preserveImportLocations", true);
        const useDigestFiles = config.get<boolean>("experimental.useDigestFiles", false);
        const importSyntax = config.get<string>("behavior.importSyntax", "curly");
        const showCodeLens = config.get<boolean>("pathConversion.enableCodeLens", true);
        const codeLensVisibility = config.get<string>("pathConversion.codeLensVisibility", "hover");
        const sortImports = config.get<boolean>("behavior.sortImportsAlphabetically", true);
        const importGrouping = config.get<string>("behavior.importGrouping", "none");

        const items: QuickPickItemWithAction[] = [];

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

        items.push({
            label: "General",
            kind: vscode.QuickPickItemKind.Separator,
        });

        // Three states, not two: a snooze suppresses imports without touching
        // the setting, so a row derived from the setting alone reads "Enabled"
        // while nothing is being imported.
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
            // Through the command rather than a second write of the same
            // setting: the command re-reads at click time, where the row's
            // captured value is a snapshot from when the menu opened.
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.toggleAutoImport");
            },
        });

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

        items.push({
            label: "Import Behavior",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(preserveLocations, "Preserve Import Locations"),
            description: preserveLocations ? "Keep imports in place" : "Consolidate at top",
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.togglePreserveLocations");
            },
        });

        items.push({
            label: toggleIcon(sortImports, "Sort Imports Alphabetically"),
            description: sortImports ? "Sorted A-Z" : "Original order preserved",
            // No registered command backs this one, so it writes through the
            // settings module directly.
            action: async () => {
                await writeSetting("behavior.sortImportsAlphabetically", !sortImports, resource);
                logger.debug("StatusBarHandler", `Sort imports alphabetically toggled: ${!sortImports}`);
            },
        });

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

        const isDotSyntax = importSyntax === "dot";
        items.push({
            label: toggleIcon(isDotSyntax, "Dot Syntax (using.)"),
            description: isDotSyntax ? "using. /Path" : "using { /Path }",
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.toggleImportSyntax");
            },
        });

        items.push({
            label: "Path Conversion",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(showCodeLens, "Path Conversion Helper"),
            description: showCodeLens ? "Enabled" : "Disabled",
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.toggleFullPathCodeLens");
            },
        });

        const visibilityLabel = codeLensVisibility === "hover" ? "Hover Only" : "Always Visible";
        items.push({
            label: `$(list-unordered) CodeLens Visibility: ${visibilityLabel} $(chevron-right)`,
            description: "When to show path conversion options",
            action: async () => {
                await this.showCodeLensVisibilityMenu();
            },
        });

        items.push({
            label: "Experimental",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(useDigestFiles, "Use Digest Files"),
            description: useDigestFiles ? "Enabled" : "Disabled",
            action: async () => {
                await vscode.commands.executeCommand("verseAutoImports.toggleDigestFiles");
            },
        });

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

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Verse Auto Imports - Quick Actions",
            matchOnDescription: true,
        });

        if (selected?.action) {
            try {
                await selected.action();
            } catch (error) {
                logger.error("StatusBarHandler", `Menu action failed: ${error}`);
                vscode.window.showErrorMessage(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /** Shows the import-grouping submenu, and returns to the main menu on Back. */
    async showImportGroupingMenu(): Promise<void> {
        const resource = activeResource();
        const config = settingsFor(resource);
        const currentGrouping = config.get<string>("behavior.importGrouping", "none");

        const items: QuickPickItemWithAction[] = [];

        items.push({
            label: "$(arrow-left) Back to main menu",
            description: "",
            action: async () => {
                await this.showMenu();
            },
        });

        items.push({
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(currentGrouping === "none", "No Grouping"),
            description: "All imports mixed together (default)",
            action: async () => {
                await writeSetting("behavior.importGrouping", "none", resource);
                logger.debug("StatusBarHandler", "Import grouping changed to: none");
                vscode.window.showInformationMessage("Import grouping disabled");
            },
        });

        items.push({
            label: toggleIcon(currentGrouping === "digestFirst", "Digest First"),
            description: "Digest imports (/Verse.org, /Fortnite.com, /UnrealEngine.com), then local imports",
            action: async () => {
                await writeSetting("behavior.importGrouping", "digestFirst", resource);
                logger.debug("StatusBarHandler", "Import grouping changed to: digestFirst");
                vscode.window.showInformationMessage("Import grouping: Digest imports first");
            },
        });

        items.push({
            label: toggleIcon(currentGrouping === "localFirst", "Local First"),
            description: "Local imports, then digest imports",
            action: async () => {
                await writeSetting("behavior.importGrouping", "localFirst", resource);
                logger.debug("StatusBarHandler", "Import grouping changed to: localFirst");
                vscode.window.showInformationMessage("Import grouping: Local imports first");
            },
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Select Import Grouping Option",
            matchOnDescription: true,
        });

        if (selected?.action) {
            try {
                await selected.action();
            } catch (error) {
                logger.error("StatusBarHandler", `Menu action failed: ${error}`);
                vscode.window.showErrorMessage(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /** Shows the CodeLens visibility submenu, and returns to the main menu on Back. */
    async showCodeLensVisibilityMenu(): Promise<void> {
        const config = settingsFor();
        const currentVisibility = config.get<string>("pathConversion.codeLensVisibility", "hover");

        const items: QuickPickItemWithAction[] = [];

        items.push({
            label: "$(arrow-left) Back to main menu",
            description: "",
            action: async () => {
                await this.showMenu();
            },
        });

        items.push({
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: toggleIcon(currentVisibility === "hover", "Hover Only"),
            description: "Show only when hovering over imports (default)",
            action: async () => {
                await writeSetting("pathConversion.codeLensVisibility", "hover");
                logger.debug("StatusBarHandler", "CodeLens visibility changed to: hover");
                vscode.window.showInformationMessage("CodeLens visibility: Hover only");
            },
        });

        items.push({
            label: toggleIcon(currentVisibility === "always", "Always Visible"),
            description: "Always show above import statements",
            action: async () => {
                await writeSetting("pathConversion.codeLensVisibility", "always");
                logger.debug("StatusBarHandler", "CodeLens visibility changed to: always");
                vscode.window.showInformationMessage("CodeLens visibility: Always visible");
            },
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Select CodeLens Visibility Option",
            matchOnDescription: true,
        });

        if (selected?.action) {
            try {
                await selected.action();
            } catch (error) {
                logger.error("StatusBarHandler", `Menu action failed: ${error}`);
                vscode.window.showErrorMessage(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * Suppresses auto imports for a number of minutes, restarting the snooze if
     * one is already running.
     */
    startSnooze(minutes: number): void {
        logger.debug("StatusBarHandler", `Starting snooze for ${minutes} minutes`);

        // Clear first so re-invoking (the command palette while already
        // snoozed, say) cannot orphan a running interval.
        this.clearSnoozeState();

        // The end time is the whole of the snooze state. No user setting is
        // touched, so nothing can survive the extension host and leave auto
        // imports disabled.
        this.snoozeEndTime = Date.now() + minutes * MS_PER_MINUTE;

        this.snoozeInterval = setInterval(() => {
            if (this.snoozeEndTime && Date.now() >= this.snoozeEndTime) {
                this.endSnooze();
            } else {
                this.updateDisplay();
            }
        }, SNOOZE_INTERVAL_MS);

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

    /** Ends the snooze at the user's request, and says so. */
    cancelSnooze(): void {
        logger.debug("StatusBarHandler", "Cancelling snooze");
        this.clearSnoozeState();

        this.updateDisplay();
        vscode.window.showInformationMessage("Auto imports resumed");
    }

    /**
     * Ends the snooze without a notification, for the case where the user has
     * just turned auto import on themselves: they already know imports are
     * back, and saying so again is noise on an action they took.
     */
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

    /**
     * Stops the countdown interval and releases the status bar item and the
     * configuration listener. The interval repeats every second until it is
     * cleared, so a snooze armed at deactivation would otherwise keep firing
     * against a torn-down status bar item.
     */
    dispose(): void {
        if (this.snoozeInterval) {
            clearInterval(this.snoozeInterval);
        }
        this.configListener.dispose();
        this.statusBarItem.dispose();
    }
}

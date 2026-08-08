import * as vscode from "vscode";
import { EnvironmentSnapshot, formatEnvironmentLines, readReportedSettings } from "./environment";

/**
 * Log levels for the logger
 */
export enum LogLevel {
    TRACE = 0,
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4,
    FATAL = 5,
}

/**
 * Interface for structured log data
 */
interface LogData {
    [key: string]: unknown;
}

/**
 * Enhanced logger for VS Code extension with dual-channel output
 * - User channel: Shows INFO+ levels for end users
 * - Debug channel: Shows all levels for debugging
 */
export class Logger {
    private static instance: Logger;
    private userChannel: vscode.OutputChannel;
    private debugChannel: vscode.OutputChannel;
    private performanceTimers: Map<string, number> = new Map();
    private logBuffer: string[] = [];
    private environment?: EnvironmentSnapshot;
    private readonly MAX_LOG_ENTRIES = 10000;

    private constructor() {
        this.userChannel = vscode.window.createOutputChannel("Verse Auto Imports");
        this.debugChannel = vscode.window.createOutputChannel("Verse Auto Imports - Debug");
    }

    /**
     * Get the singleton logger instance
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Initialize the logger and register channels with the extension context
     */
    public initialize(context: vscode.ExtensionContext): void {
        context.subscriptions.push(this.userChannel);
        context.subscriptions.push(this.debugChannel);
    }

    /**
     * Record which build and host this session is running on, so an exported
     * log can be tied back to a specific vsix. Set once at activation.
     */
    public setEnvironment(snapshot: EnvironmentSnapshot): void {
        this.environment = snapshot;
    }

    /**
     * Log a TRACE level message (most detailed)
     */
    public trace(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.TRACE, module, message, data);
    }

    /**
     * Log a DEBUG level message
     */
    public debug(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.DEBUG, module, message, data);
    }

    /**
     * Log an INFO level message
     */
    public info(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.INFO, module, message, data);
    }

    /**
     * Log a WARN level message
     */
    public warn(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.WARN, module, message, data);
    }

    /**
     * Extract structured data from an error object
     */
    private extractErrorData(error: Error | unknown): LogData {
        if (error instanceof Error) {
            return {
                errorMessage: error.message,
                errorStack: error.stack,
            };
        }
        return { error: String(error) };
    }

    /**
     * Log an ERROR level message with optional error object
     */
    public error(module: string, message: string, error?: Error | unknown, data?: LogData): void {
        const logData = error ? { ...data, ...this.extractErrorData(error) } : { ...data };
        this.log(LogLevel.ERROR, module, message, logData);
    }

    /**
     * Log a FATAL level message with optional error object
     */
    public fatal(module: string, message: string, error?: Error | unknown, data?: LogData): void {
        const logData = error ? { ...data, ...this.extractErrorData(error) } : { ...data };
        this.log(LogLevel.FATAL, module, message, logData);
    }

    /**
     * Start a performance timer
     */
    public startTimer(operationId: string): void {
        this.performanceTimers.set(operationId, Date.now());
    }

    /**
     * End a performance timer and log the duration
     */
    public endTimer(operationId: string, module: string, message: string): number {
        const startTime = this.performanceTimers.get(operationId);
        if (!startTime) {
            this.warn(module, `Timer '${operationId}' was not started`);
            return 0;
        }

        const duration = Date.now() - startTime;
        this.performanceTimers.delete(operationId);

        const logLevel = duration > 1000 ? LogLevel.WARN : LogLevel.DEBUG;
        this.log(logLevel, module, `${message} (${duration}ms)`, { duration, operationId });

        return duration;
    }

    /**
     * Show the user output channel
     */
    public showUserChannel(): void {
        this.userChannel.show();
    }

    /**
     * Show the debug output channel
     */
    public showDebugChannel(): void {
        this.debugChannel.show();
    }

    /**
     * Clear both output channels
     */
    public clearChannels(): void {
        this.userChannel.clear();
        this.debugChannel.clear();
    }

    /**
     * Get the user output channel (for backward compatibility)
     */
    public getUserChannel(): vscode.OutputChannel {
        return this.userChannel;
    }

    /**
     * Get the current number of log entries in the buffer
     */
    public getBufferSize(): number {
        return this.logBuffer.length;
    }

    /**
     * Get debug logs as a single string for file export
     */
    public getDebugLogsAsString(): string {
        const header = [
            "Verse Auto Imports - Debug Log Export",
            `Exported: ${new Date().toISOString()}`,
            `Entries: ${this.logBuffer.length}`,
            // The buffer is circular, so a long session pushes the activation
            // entries out of the export. The header is what still says which
            // build produced the log.
            ...(this.environment ? formatEnvironmentLines(this.environment, readReportedSettings()) : []),
            "-------------------------------------------",
            "",
        ].join("\n");

        return header + this.logBuffer.join("\n");
    }

    /**
     * Export debug logs to a file chosen by the user
     * @returns The URI of the saved file, or undefined if cancelled/failed
     */
    public async exportDebugLogs(): Promise<vscode.Uri | undefined> {
        const timestamp = this.formatTimestampForFilename(new Date());
        const defaultFileName = `verseAutoImports_debugLogs_${timestamp}.log`;

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultFileName),
            filters: {
                "Log Files": ["log"],
                "Text Files": ["txt"],
                "All Files": ["*"],
            },
            saveLabel: "Export Debug Logs",
            title: "Export Verse Auto Imports Debug Logs",
        });

        if (!uri) {
            return undefined; // User cancelled
        }

        try {
            const content = this.getDebugLogsAsString();
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(uri, encoder.encode(content));

            this.info("Logger", `Debug logs exported to ${uri.fsPath}`);
            return uri;
        } catch (error) {
            this.error("Logger", "Failed to export debug logs", error);
            throw error;
        }
    }

    /**
     * Format a timestamp for use in the export filename
     */
    private formatTimestampForFilename(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");

        return `${year}${month}${day}_${hours}${minutes}${seconds}`;
    }

    /**
     * Core logging method
     */
    private log(level: LogLevel, module: string, message: string, data?: LogData): void {
        const timestamp = new Date();
        const levelName = LogLevel[level];

        // Format for user channel (INFO+ levels only)
        if (level >= LogLevel.INFO) {
            const userFormat = this.formatUserMessage(timestamp, levelName, message);
            this.userChannel.appendLine(userFormat);
        }

        // Format for debug channel (all levels)
        const debugFormat = this.formatDebugMessage(timestamp, levelName, module, message, data);
        this.debugChannel.appendLine(debugFormat);

        // Store in buffer for export
        this.addToBuffer(debugFormat);
    }

    /**
     * Add a log entry to the circular buffer
     */
    private addToBuffer(logEntry: string): void {
        if (this.logBuffer.length >= this.MAX_LOG_ENTRIES) {
            this.logBuffer.shift(); // Remove oldest entry
        }
        this.logBuffer.push(logEntry);
    }

    /**
     * Format message for user channel (simpler format)
     */
    private formatUserMessage(timestamp: Date, level: string, message: string): string {
        const time = timestamp.toTimeString().substring(0, 8);
        return `[${time}] [${level}] ${message}`;
    }

    /**
     * Format message for debug channel (detailed format)
     */
    private formatDebugMessage(timestamp: Date, level: string, module: string, message: string, data?: LogData): string {
        const time = timestamp.toISOString().substring(11, 23);
        let formatted = `[${time}] [${level}] [${module}] ${message}`;

        if (data && Object.keys(data).length > 0) {
            // Format data object, handling special cases
            const dataStr = this.formatLogData(data);
            if (dataStr) {
                formatted += ` ${dataStr}`;
            }
        }

        return formatted;
    }

    /**
     * Format log data for output
     */
    private formatLogData(data: LogData): string {
        const parts: string[] = [];

        for (const [key, value] of Object.entries(data)) {
            if (key === "errorStack" && typeof value === "string") {
                // Handle stack traces specially
                parts.push(`\n  Stack trace:\n    ${value.replace(/\n/g, "\n    ")}`);
            } else if (value !== undefined && value !== null) {
                // Handle other values
                let valueStr: string;
                if (typeof value === "string") {
                    valueStr = value;
                } else if (typeof value === "object") {
                    try {
                        valueStr = JSON.stringify(value, null, 2);
                    } catch {
                        valueStr = String(value);
                    }
                } else {
                    valueStr = String(value);
                }
                parts.push(`${key}=${valueStr}`);
            }
        }

        return parts.length > 0 ? `{ ${parts.join(", ")} }` : "";
    }
}

// Export singleton instance for convenience
export const logger = Logger.getInstance();

import * as vscode from "vscode";
import { EnvironmentSnapshot, formatEnvironmentLines, readSessionState } from "./environment";

/**
 * Severity, ordered: the numeric value is compared against INFO to decide
 * whether an entry reaches the user channel, so the order is load-bearing.
 */
export enum LogLevel {
    TRACE = 0,
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4,
    FATAL = 5,
}

interface LogData {
    [key: string]: unknown;
}

/**
 * Writes to two output channels at once: INFO and above reach the channel the
 * user sees, while every level reaches the debug channel and the export
 * buffer. Anything logged below INFO is therefore invisible in the UI but
 * still present in an exported log.
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
     * The one Logger, created on first call. Both output channels are created
     * with it, so nothing may call this before the extension host is up.
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Hands both channels to the extension context so they are disposed on
     * deactivation. Logging works without this; only cleanup depends on it.
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

    public trace(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.TRACE, module, message, data);
    }

    public debug(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.DEBUG, module, message, data);
    }

    public info(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.INFO, module, message, data);
    }

    public warn(module: string, message: string, data?: LogData): void {
        this.log(LogLevel.WARN, module, message, data);
    }

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
     * @param error unwrapped into errorMessage and errorStack, which override
     * keys of the same name in `data`
     */
    public error(module: string, message: string, error?: Error | unknown, data?: LogData): void {
        const logData = error ? { ...data, ...this.extractErrorData(error) } : { ...data };
        this.log(LogLevel.ERROR, module, message, logData);
    }

    /**
     * @param error unwrapped as in `error()`
     */
    public fatal(module: string, message: string, error?: Error | unknown, data?: LogData): void {
        const logData = error ? { ...data, ...this.extractErrorData(error) } : { ...data };
        this.log(LogLevel.FATAL, module, message, logData);
    }

    public startTimer(operationId: string): void {
        this.performanceTimers.set(operationId, Date.now());
    }

    /**
     * Stops the timer, logs the elapsed time and returns it in milliseconds.
     * Anything over a second is logged at WARN rather than DEBUG, so a slow
     * operation surfaces in the user's channel without a caller deciding.
     *
     * Returns 0 for an operation that was never started, having warned.
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

    public showUserChannel(): void {
        this.userChannel.show();
    }

    public showDebugChannel(): void {
        this.debugChannel.show();
    }

    /**
     * Clears what both channels display. The export buffer is untouched, so a
     * log exported afterwards still holds everything.
     */
    public clearChannels(): void {
        this.userChannel.clear();
        this.debugChannel.clear();
    }

    /**
     * The user channel itself, for the callers that need to show it or hand it
     * on. Logging goes through this class, not through the returned channel.
     */
    public getUserChannel(): vscode.OutputChannel {
        return this.userChannel;
    }

    public getBufferSize(): number {
        return this.logBuffer.length;
    }

    /**
     * The whole export: a header identifying the build, then every buffered
     * entry.
     */
    public getDebugLogsAsString(): string {
        const header = [
            "Verse Auto Imports - Debug Log Export",
            `Exported: ${new Date().toISOString()}`,
            `Entries: ${this.logBuffer.length}`,
            // The buffer is circular, so a long session pushes the activation
            // entries out of the export. The header is what still says which
            // build produced the log.
            ...(this.environment ? formatEnvironmentLines(this.environment, readSessionState()) : []),
            "-------------------------------------------",
            "",
        ].join("\n");

        return header + this.logBuffer.join("\n");
    }

    /**
     * Prompts for a location and writes the export there.
     * @returns undefined when the user cancels; write failures throw
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
            return undefined;
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

    /** Local time as `YYYYMMDD_HHMMSS`, safe for a filename on any platform. */
    private formatTimestampForFilename(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");

        return `${year}${month}${day}_${hours}${minutes}${seconds}`;
    }

    private log(level: LogLevel, module: string, message: string, data?: LogData): void {
        const timestamp = new Date();
        const levelName = LogLevel[level];

        if (level >= LogLevel.INFO) {
            const userFormat = this.formatUserMessage(timestamp, levelName, message);
            this.userChannel.appendLine(userFormat);
        }

        // The debug format is what gets buffered, so the export carries the
        // module name and structured data that the user channel drops.
        const debugFormat = this.formatDebugMessage(timestamp, levelName, module, message, data);
        this.debugChannel.appendLine(debugFormat);

        this.addToBuffer(debugFormat);
    }

    /**
     * Appends to the export buffer, dropping the oldest entry once it holds
     * MAX_LOG_ENTRIES. A long session therefore loses its activation entries,
     * which is why the export header repeats the environment.
     */
    private addToBuffer(logEntry: string): void {
        if (this.logBuffer.length >= this.MAX_LOG_ENTRIES) {
            this.logBuffer.shift();
        }
        this.logBuffer.push(logEntry);
    }

    /** Wall-clock time, level and message. No module name and no data. */
    private formatUserMessage(timestamp: Date, level: string, message: string): string {
        const time = timestamp.toTimeString().substring(0, 8);
        return `[${time}] [${level}] ${message}`;
    }

    /** UTC time to the millisecond, level, module, message, then any data. */
    private formatDebugMessage(timestamp: Date, level: string, module: string, message: string, data?: LogData): string {
        const time = timestamp.toISOString().substring(11, 23);
        let formatted = `[${time}] [${level}] [${module}] ${message}`;

        if (data && Object.keys(data).length > 0) {
            const dataStr = this.formatLogData(data);
            if (dataStr) {
                formatted += ` ${dataStr}`;
            }
        }

        return formatted;
    }

    /**
     * Renders the data object into one line, dropping undefined and null
     * entries. A stack trace breaks the line instead, indented under its own
     * heading, so it stays readable in the channel.
     */
    private formatLogData(data: LogData): string {
        const parts: string[] = [];

        for (const [key, value] of Object.entries(data)) {
            if (key === "errorStack" && typeof value === "string") {
                parts.push(`\n  Stack trace:\n    ${value.replace(/\n/g, "\n    ")}`);
            } else if (value !== undefined && value !== null) {
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

/** The shared logger. Take this rather than calling `getInstance` again. */
export const logger = Logger.getInstance();

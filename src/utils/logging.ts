import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel;

export function setupLogging(context: vscode.ExtensionContext): vscode.OutputChannel {
    outputChannel = vscode.window.createOutputChannel('Verse Auto Imports');
    context.subscriptions.push(outputChannel);
    return outputChannel;
}

export function log(channel: vscode.OutputChannel, message: string) {
    channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
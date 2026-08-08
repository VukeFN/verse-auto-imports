import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const EXTENSION_ID = "vukefn.verse-auto-imports";

/** One entry in test-fixtures/corpus/<version>/diagnostics.json. */
interface CorpusEntry {
    id: string;
    source: string;
    context: string;
    message: string;
    expected: {
        suggestions: string[];
        optimizePaths: string[];
    };
}

interface CorpusFile {
    uefnVersion: string;
    entries: CorpusEntry[];
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CORPUS_PATH = path.join(REPO_ROOT, "test-fixtures", "corpus", "41.10", "diagnostics.json");

let corpusCache: CorpusFile | null = null;

/**
 * Loads a recorded compiler message from the diagnostics corpus. The corpus is
 * the single source of truth for message shapes; tests never hand-write
 * compiler messages.
 */
export function corpusMessage(id: string): string {
    if (!corpusCache) {
        corpusCache = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as CorpusFile;
    }
    const entry = corpusCache.entries.find((candidate) => candidate.id === id);
    if (!entry) {
        throw new Error(`Corpus entry '${id}' not found in ${CORPUS_PATH}`);
    }
    return entry.message;
}

/** Root of the Content workspace folder inside the (temp-copied) fixture workspace. */
export function contentRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === "Content");
    if (!folder) {
        throw new Error("Fixture workspace is missing its Content folder; was the .code-workspace opened?");
    }
    return folder.uri.fsPath;
}

export async function ensureActivated(): Promise<void> {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (!extension) {
        throw new Error(`${EXTENSION_ID} not found in the test host`);
    }
    if (!extension.isActive) {
        await extension.activate();
    }
}

/** Opens a Content fixture, shows it in the active editor, and makes sure the extension is up. */
export async function openFixture(fileName: string): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(path.join(contentRoot(), fileName));
    await vscode.window.showTextDocument(document, { preview: false });
    await ensureActivated();
    return document;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes CRLF to LF. Fixture checkouts on Windows CI (and real user
 * documents) carry CRLF; assertions and predicates always see LF so they can
 * use literal \n and $ anchors.
 */
export function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

/** The document text with line endings normalized to LF, for assertions. */
export function docText(document: vscode.TextDocument): string {
    return normalizeEol(document.getText());
}

export function countOccurrences(text: string, needle: string): number {
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
        count++;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * Injects diagnostics through a test-owned DiagnosticCollection. The extension
 * consumes diagnostics via onDidChangeDiagnostics/getDiagnostics without
 * filtering by source (extension.ts), so recorded compiler messages injected
 * here drive the exact same pipeline as live Verse LSP output.
 */
export class DiagnosticInjector {
    private readonly collection: vscode.DiagnosticCollection;

    constructor(name: string) {
        this.collection = vscode.languages.createDiagnosticCollection(name);
    }

    /**
     * Sets one Error diagnostic per message on the document. When an anchor
     * identifier is given and present in the document, the diagnostics point
     * at its first occurrence (needed for range-based quick fix queries);
     * otherwise they sit at the start of the file.
     */
    inject(document: vscode.TextDocument, messages: string[], anchorIdentifier?: string): void {
        const range = this.rangeFor(document, anchorIdentifier);
        const diagnostics = messages.map((message) => {
            const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
            diagnostic.source = "Verse";
            return diagnostic;
        });
        this.collection.set(document.uri, diagnostics);
    }

    /**
     * Sets diagnostics on a uri with no open document behind it, which is how
     * the Verse LSP publishes them: project-wide, for files the user never
     * opened. Ranges sit at the start of the file, since there is no text to
     * anchor against.
     */
    injectUri(uri: vscode.Uri, messages: string[]): void {
        const diagnostics = messages.map((message) => {
            const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, vscode.DiagnosticSeverity.Error);
            diagnostic.source = "Verse";
            return diagnostic;
        });
        this.collection.set(uri, diagnostics);
    }

    private rangeFor(document: vscode.TextDocument, anchorIdentifier?: string): vscode.Range {
        if (anchorIdentifier) {
            const offset = document.getText().indexOf(anchorIdentifier);
            if (offset !== -1) {
                return new vscode.Range(document.positionAt(offset), document.positionAt(offset + anchorIdentifier.length));
            }
        }
        return new vscode.Range(0, 0, 0, 1);
    }

    clear(): void {
        this.collection.clear();
    }

    dispose(): void {
        this.collection.dispose();
    }
}

/**
 * Resolves once the document text satisfies the predicate, driven by
 * onDidChangeTextDocument rather than polling. Rejects on timeout with the
 * final document text for diagnosis.
 */
export function waitForDocumentChange(document: vscode.TextDocument, predicate: (text: string) => boolean, label: string, timeoutMs: number = 5000): Promise<void> {
    if (predicate(docText(document))) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        let subscription: vscode.Disposable | undefined;
        const timer = setTimeout(() => {
            subscription?.dispose();
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. Document text:\n${document.getText()}`));
        }, timeoutMs);
        subscription = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.uri.toString() !== document.uri.toString()) {
                return;
            }
            if (predicate(docText(event.document))) {
                clearTimeout(timer);
                subscription?.dispose();
                resolve();
            }
        });
    });
}

/**
 * Negative-case helper: fails if the document receives any edit within the
 * window. The window comfortably covers the fixture workspace's 100ms
 * auto-import debounce.
 */
export async function assertNoDocumentChange(document: vscode.TextDocument, windowMs: number = 1500): Promise<void> {
    const edits: string[] = [];
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === document.uri.toString() && event.contentChanges.length > 0) {
            edits.push(event.contentChanges.map((change) => JSON.stringify(change.text)).join(", "));
        }
    });
    await sleep(windowMs);
    subscription.dispose();
    assert.strictEqual(edits.length, 0, `Expected no edits to ${path.basename(document.uri.fsPath)} within ${windowMs}ms, got inserts: ${edits.join(" | ")}`);
}

/**
 * Workspace-level configuration overrides with teardown. Workspace scope
 * overrides both the fixture defaults and any Global writes made by the
 * extension, and restoring to undefined removes the override again.
 */
export class WorkspaceSettings {
    private readonly touchedKeys = new Set<string>();

    async set(key: string, value: unknown): Promise<void> {
        this.touchedKeys.add(key);
        await vscode.workspace.getConfiguration("verseAutoImports").update(key, value, vscode.ConfigurationTarget.Workspace);
    }

    async restoreAll(): Promise<void> {
        const config = vscode.workspace.getConfiguration("verseAutoImports");
        for (const key of this.touchedKeys) {
            await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        }
        this.touchedKeys.clear();
    }
}

/**
 * Runs Optimize Imports on the document (which must become the active editor)
 * and waits out the async on-save spacing pass before returning the text.
 */
export async function runOptimizeImports(document: vscode.TextDocument): Promise<string> {
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("verseAutoImports.optimizeImports");
    await sleep(500);
    return docText(document);
}

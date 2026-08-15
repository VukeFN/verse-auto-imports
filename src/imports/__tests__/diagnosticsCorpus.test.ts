import * as fs from "fs";
import * as path from "path";
import { ImportSuggestionExtractor } from "../ImportSuggestionExtractor";
import { ImportFormatter } from "../ImportFormatter";
import * as vscode from "vscode";

interface CorpusEntry {
    id: string;
    source: "captured" | "book" | "synthetic";
    context?: string;
    message: string;
    /**
     * Per-entry config overrides, keyed the way config.get() is called (e.g.
     * "behavior.ambiguousImports"). Applied only to suggestion extraction -
     * extractImportsFromDiagnostics never reads configuration, so a settings
     * override has no effect on the optimize-path assertion below.
     */
    settings?: Record<string, unknown>;
    expected: {
        suggestions: string[];
        optimizePaths: string[];
    };
}

interface CorpusFile {
    uefnVersion: string;
    capturedAt: string;
    notes?: string;
    entries: CorpusEntry[];
}

const corpusRoot = path.resolve(__dirname, "../../../test-fixtures/corpus");

const corpora: CorpusFile[] = fs
    .readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(corpusRoot, entry.name, "diagnostics.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as CorpusFile);

describe("diagnostics corpus", () => {
    it("has at least one corpus version with entries", () => {
        expect(corpora.length).toBeGreaterThan(0);
        expect(corpora.every((corpus) => corpus.entries.length > 0)).toBe(true);
    });

    for (const corpus of corpora) {
        describe(`UEFN ${corpus.uefnVersion}`, () => {
            let extractor: ImportSuggestionExtractor;

            beforeEach(() => {
                const outputChannel = vscode.window.createOutputChannel("test");
                extractor = new ImportSuggestionExtractor(outputChannel, new ImportFormatter());
            });

            it.each(corpus.entries.map((entry) => [entry.id, entry] as const))("%s: suggestion extraction", async (_id, entry) => {
                if (entry.settings) {
                    const settings = entry.settings;
                    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
                        get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => (key in settings ? settings[key] : defaultValue)),
                        update: jest.fn().mockResolvedValue(undefined),
                    });
                }
                const suggestions = await extractor.extractImportSuggestions(entry.message);
                expect(suggestions.map((suggestion) => suggestion.importStatement)).toEqual(entry.expected.suggestions);
            });

            it.each(corpus.entries.map((entry) => [entry.id, entry] as const))("%s: optimize path extraction", (_id, entry) => {
                const { paths } = extractor.extractImportsFromDiagnostics([
                    { message: entry.message, range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)) } as vscode.Diagnostic,
                ]);
                expect(paths).toEqual(entry.expected.optimizePaths);
            });
        });
    }
});

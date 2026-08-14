import { QueuedEdit, verifyImportEdits, verifyOrganizedRewrite } from "../ImportRewriteGuard";

/** A whole-line removal, the only shape the writers produce. */
function removal(startLine: number, endLineExclusive: number, newText = ""): QueuedEdit {
    return { startLine, startCharacter: 0, endLine: endLineExclusive, endCharacter: 0, newText };
}

function insertion(line: number, newText: string): QueuedEdit {
    return { startLine: line, startCharacter: 0, endLine: line, endCharacter: 0, newText };
}

describe("verifyOrganizedRewrite", () => {
    it("passes a consolidation that keeps every path and every body line", () => {
        const before = "using { /B }\nusing { /A }\ncode()";
        const after = "using { /A }\nusing { /B }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBeNull();
    });

    it("reports an import the rebuild dropped", () => {
        const before = "using { /A }\nusing { /B }\ncode()";
        const after = "using { /A }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe("the rebuilt document no longer imports /B");
    });

    it("reports an import nothing asked for", () => {
        const before = "using { /A }\ncode()";
        const after = "using { /A }\nusing { /C }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe("the rebuilt document imports /C, which nothing asked for");
    });

    it("accepts an import the caller asked to add", () => {
        const before = "using { /A }\ncode()";
        const after = "using { /A }\nusing { /C }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, ["/C"])).toBeNull();
    });

    // The whole point of the guard: a rebuild that loses a line of the user's
    // own code must never reach applyEdit.
    it("reports a body line the rebuild lost", () => {
        const before = "using { /A }\ncode()\nmore()";
        const after = "using { /A }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe('1 code line(s) outside the imports were lost, from "more()"');
    });

    it("reports a body line the rebuild claimed twice", () => {
        const before = "using { /A }\ncode()\nmore()";
        const after = "using { /A }\n\ncode()\ncode()\nmore()";

        expect(verifyOrganizedRewrite(before, after, [])).toContain("code line 2 outside the imports");
    });

    it("reports a body line the rebuild rewrote", () => {
        const before = "using { /A }\ncode()";
        const after = "using { /A }\n\ncodeX()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe('code line 1 outside the imports became "codeX()", was "code()"');
    });

    // Withholding an already-made import deletes the comments written for it on
    // purpose, so a check demanding every comment survive would refuse correct
    // output. See ImportDocumentEditor.buildOrganizedContent.
    it("accepts a rewrite that dropped a comment", () => {
        const before = "using { /A }\n# why /B is here\nusing { /B }\ncode()";
        const after = "using { /A }\nusing { /B }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBeNull();
    });

    it("accepts a rewrite that trimmed the blank lines a hoisted block left behind", () => {
        const before = "using { /A }\n\n\n\ncode()";
        const after = "using { /A }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBeNull();
    });

    // A line holding both an import and code is pinned rather than rebuilt, so
    // it is inside an import span on both sides and neither side compares its
    // text. The path check is what covers it.
    it("reports the lost path when a rewrite drops a line holding an import and code", () => {
        const before = "using { /A }\nX := 1; using. /B\ncode()";
        const after = "using { /A }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe("the rebuilt document no longer imports /B");
    });
});

describe("verifyImportEdits", () => {
    it("passes an edit that only inserts", () => {
        const lines = ["code()"];

        expect(verifyImportEdits(lines, [insertion(0, "using { /A }\n")])).toBeNull();
    });

    it("passes a block replacement that writes its paths back", () => {
        const lines = ["using { /B }", "using { /A }", "code()"];

        expect(verifyImportEdits(lines, [removal(0, 2, "using { /A }\nusing { /B }\n")])).toBeNull();
    });

    it("passes a consolidation that deletes a block and rewrites it at the top", () => {
        const lines = ["code()", "using { /A }", "using { /B }"];
        const edits = [insertion(0, "using { /A }\nusing { /B }\n"), removal(1, 3)];

        expect(verifyImportEdits(lines, edits)).toBeNull();
    });

    // The off-by-one the ticket names: a run reaching one line past the block
    // takes a line of the user's code with it.
    it("refuses a range that reaches past the imports onto code", () => {
        const lines = ["using { /A }", "code()"];

        expect(verifyImportEdits(lines, [removal(0, 2, "using { /A }\n")])).toBe('the queued edits remove line 2, which is code rather than an import: "code()"');
    });

    it("refuses a deletion that never writes the path back", () => {
        const lines = ["using { /A }", "using { /B }", "code()"];

        expect(verifyImportEdits(lines, [removal(0, 2)])).toBe("the queued edits remove /A, /B without writing it back");
    });

    // A path written twice is still imported while either line is left alone,
    // so removing one copy is a deduplication rather than a loss.
    it("passes a deletion that leaves another statement for the same path", () => {
        const lines = ["using { /A }", "using { /A }", "code()"];

        expect(verifyImportEdits(lines, [removal(1, 2)])).toBeNull();
    });

    it("treats a range ending at character 0 as stopping above that line", () => {
        const lines = ["using { /A }", "code()"];

        expect(verifyImportEdits(lines, [removal(0, 1, "using { /A }\n")])).toBeNull();
    });

    it("counts a line a range only partly covers as removed", () => {
        const lines = ["using { /A }", "code()"];

        expect(verifyImportEdits(lines, [{ startLine: 0, startCharacter: 0, endLine: 1, endCharacter: 3, newText: "using { /A }\n" }])).toContain("line 2, which is code");
    });

    // VS Code clamps a range past the end onto the document, so there is no
    // line under those indices to classify.
    it("ignores the part of a range that reaches past the last line", () => {
        const lines = ["using { /A }"];

        expect(verifyImportEdits(lines, [removal(0, 5, "using { /A }\n")])).toBeNull();
    });

    // insertImportLines writes past the last line from the end of that line
    // rather than from column 0, which is still an insertion and removes
    // nothing.
    it("passes an insertion anchored at the end of the last line", () => {
        const lines = ["using { /A }", "code()"];
        const endOfLastLine: QueuedEdit = { startLine: 1, startCharacter: 6, endLine: 1, endCharacter: 6, newText: "\nusing { /B }" };

        expect(verifyImportEdits(lines, [endOfLastLine])).toBeNull();
    });
});

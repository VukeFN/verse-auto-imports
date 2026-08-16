import { verifyOrganizedRewrite } from "../ImportRewriteGuard";

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
    // own code must never reach applyEdit. The line in the message is the input
    // document's, not a position in the filtered sequence, since it is all a
    // maintainer gets when the guard fires.
    it("reports a body line the rebuild lost, by its line in the input", () => {
        const before = "using { /A }\ncode()\nmore()";
        const after = "using { /A }\n\ncode()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe('1 code line(s) were lost, from line 3: "more()"');
    });

    it("reports a body line the rebuild claimed twice", () => {
        const before = "using { /A }\ncode()\nmore()";
        const after = "using { /A }\n\ncode()\ncode()\nmore()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe('line 3 became "code()", was "more()"');
    });

    it("reports a body line the rebuild rewrote", () => {
        const before = "using { /A }\ncode()";
        const after = "using { /A }\n\ncodeX()";

        expect(verifyOrganizedRewrite(before, after, [])).toBe('line 2 became "codeX()", was "code()"');
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

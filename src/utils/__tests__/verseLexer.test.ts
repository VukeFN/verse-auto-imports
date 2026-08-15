import { lexVerseLine } from "../verseLexer";

/** The lexer's entry state for a line nothing above it left open. */
const atCodeScope = { depth: 0, markerIndent: null, openFrames: [], lineComment: null };

describe("lexVerseLine commentStart", () => {
    it("reports -1 for a line holding no comment", () => {
        expect(lexVerseLine("using { /A }", atCodeScope).commentStart).toBe(-1);
    });

    it("reports the offset of a line comment", () => {
        expect(lexVerseLine("using { /A } # note", atCodeScope).commentStart).toBe(13);
    });

    it("reports the offset of the `<` a block comment opens with", () => {
        expect(lexVerseLine("using { /A } <# note #>", atCodeScope).commentStart).toBe(13);
    });

    it("reports the offset of an indented comment marker", () => {
        expect(lexVerseLine("using { /A } <#> note", atCodeScope).commentStart).toBe(13);
    });

    it("keeps the first opener when the line holds several", () => {
        expect(lexVerseLine("us<##>ing { /A } # note", atCodeScope).commentStart).toBe(2);
    });

    it("passes over a `#` inside a quoted segment suffix", () => {
        // `IsIdentifierQuotable` (VerseGrammar.h:377) excludes `#` only before a
        // `>`, so this one is identifier text and the comment is the later one.
        expect(lexVerseLine("using { /Mod'a#b' } # note", atCodeScope).commentStart).toBe(20);
    });

    it("passes over a `#` inside a string or char literal", () => {
        expect(lexVerseLine('Msg := "a#b" # note', atCodeScope).commentStart).toBe(13);
        expect(lexVerseLine("Hash := '#' # note", atCodeScope).commentStart).toBe(12);
    });

    it("reports none for a `#` the lexer never resolved, inside an unterminated literal", () => {
        expect(lexVerseLine("using { /A'x # note", atCodeScope).commentStart).toBe(-1);
    });

    it("reports 0 for a line whose opener is above it", () => {
        // 0 even where the line closes that comment and carries live code, which
        // is why only a depthBefore-0 line may be split on the offset.
        expect(lexVerseLine("still comment text", { depth: 1, markerIndent: null, openFrames: [], lineComment: null }).commentStart).toBe(0);

        const closes = lexVerseLine("#> using { /A }", { depth: 1, markerIndent: null, openFrames: [], lineComment: null });
        expect(closes.commentStart).toBe(0);
        expect(closes.hasCode).toBe(true);
    });

    it("reports 0 for a line inside the body of a `<#>` marker", () => {
        expect(lexVerseLine("    body text", { depth: 0, markerIndent: 0, openFrames: [], lineComment: null }).commentStart).toBe(0);
    });
});

describe("lexVerseLine, a block comment opened in a line comment's text", () => {
    it("opens one from a `<#>` marker's own tail, and holds the body back until it closes", () => {
        const marker = lexVerseLine("using { /A } <#> note <# opener", atCodeScope);

        expect(marker.commentStart).toBe(13);
        expect(marker.depth).toBe(1);
        // The tail's `<#` opened a block, so the marker's body has not begun and
        // there is no indentation to report for it yet.
        expect(marker.opensIndentedComment).toBe(false);
        expect(marker.markerIndent).toBeNull();
    });

    it("opens the body on the line that closes the block, at that line's indentation", () => {
        const marker = lexVerseLine("<#> note <# opener", atCodeScope);
        const closes = lexVerseLine("    #>", { depth: marker.depth, markerIndent: marker.markerIndent, openFrames: [], lineComment: marker.lineComment });

        expect(closes.opensIndentedComment).toBe(true);
        expect(closes.markerIndent).toBe(4);
    });

    it("keeps the tail of the line the block closed on as comment text", () => {
        const opener = lexVerseLine("# open <# here", atCodeScope);
        const closes = lexVerseLine("#> using { /A }", { depth: opener.depth, markerIndent: null, openFrames: [], lineComment: opener.lineComment });

        expect(closes.hasCode).toBe(false);
        expect(closes.codeOutsideLiterals).toBe("");
        // And the comment ends with that line, so nothing carries below it.
        expect(closes.lineComment).toBeNull();
        expect(closes.depth).toBe(0);
    });
});

import { lexVerseLine } from "../verseLexer";

/** The lexer's entry state for a line nothing above it left open. */
const atCodeScope = { depth: 0, markerIndent: null, openFrames: [] };

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
        expect(lexVerseLine("still comment text", { depth: 1, markerIndent: null, openFrames: [] }).commentStart).toBe(0);

        const closes = lexVerseLine("#> using { /A }", { depth: 1, markerIndent: null, openFrames: [] });
        expect(closes.commentStart).toBe(0);
        expect(closes.hasCode).toBe(true);
    });

    it("reports 0 for a line inside the body of a `<#>` marker", () => {
        expect(lexVerseLine("    body text", { depth: 0, markerIndent: 0, openFrames: [] }).commentStart).toBe(0);
    });
});

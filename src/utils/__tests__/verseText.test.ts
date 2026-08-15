import { countBraces, lineIndentWidth, maskCommentsAndStrings, popClosedBlocks, scanBraces } from "../verseText";

/**
 * The masker's contract, rather than its lexing: which Verse constructs it
 * removes is the lexer's question and is pinned by the shared probe corpus. What
 * is pinned here is what its callers depend on and the corpus cannot see - that
 * an offset into the result still addresses the original text.
 */
describe("maskCommentsAndStrings", () => {
    it("returns text exactly as long as it was given, so offsets still hold", () => {
        const content = 'Tools := module {} # note\nTag := "a#b"\nMore := 1\n';

        expect(maskCommentsAndStrings(content)).toHaveLength(content.length);
    });

    it("keeps every newline where it was, so line numbers still hold", () => {
        const content = "<#\nhidden\n#>\nReal := 1\n";
        const masked = maskCommentsAndStrings(content);

        expect(masked.split("\n")).toHaveLength(content.split("\n").length);
        expect(masked.split("\n")[3]).toBe("Real := 1");
    });

    it("leaves a CRLF carriage return alone outside a comment", () => {
        const content = "Real := 1\r\nMore := 2\r\n";

        expect(maskCommentsAndStrings(content)).toBe(content);
    });

    it("blanks a carriage return that falls inside a comment, as it blanks any other character there", () => {
        // Length is what the offset contract needs, and it holds. The `\r` is
        // comment text like the rest of the line, so nothing distinguishes it.
        const content = "Real := 1 # note\r\nMore := 2\r\n";
        const masked = maskCommentsAndStrings(content);

        expect(masked).toHaveLength(content.length);
        expect(masked.split("\n")[1]).toBe("More := 2\r");
    });

    it("blanks rather than deletes, so the text around a comment does not join", () => {
        expect(maskCommentsAndStrings("A<# note #>B\n")).toBe("A          B\n");
    });
});

/**
 * The brace primitive both module scans delimit a braced body with. It reads
 * masked text and nothing else: which braces reach it is the masker's question,
 * so what is pinned here is the counting, the range, and where a body closes.
 */
describe("scanBraces", () => {
    it("counts only within the half-open range", () => {
        expect(scanBraces("{{}}", 0, 2, 0).depth).toBe(2);
        expect(scanBraces("{{}}", 2, 4, 2).depth).toBe(0);
    });

    it("carries the depth it was handed", () => {
        expect(scanBraces("}", 0, 1, 3).depth).toBe(2);
    });

    it("reports the brace that returned the depth to zero, not the last one on the line", () => {
        expect(scanBraces("{ A } { B }", 0, 11, 0).closedAt).toBe(4);
    });

    it("reports no close where the depth never returned to zero", () => {
        expect(scanBraces("{ A", 0, 3, 0).closedAt).toBe(-1);
    });

    it("counts a brace the lexer left standing, whatever quotes surround it", () => {
        // Pins that no quote heuristic lives here: deciding which braces are
        // real is the lexer's, so text that reached this unlexed is counted
        // exactly as written.
        expect(countBraces("A'{'B", 0, 5, 0)).toBe(1);
    });
});

/**
 * The line-based indentation pair both digest parsers track block bodies with.
 * Each parser reads only the aggregate result, so these pin the boundaries -
 * tab width, and which blocks a given dedent closes - directly.
 */
describe("lineIndentWidth", () => {
    it("counts spaces", () => {
        expect(lineIndentWidth("Foo := class:")).toBe(0);
        expect(lineIndentWidth("    Field:int = 1")).toBe(4);
    });

    it("counts a tab as four spaces, so mixed indentation compares", () => {
        expect(lineIndentWidth("\tField:int = 1")).toBe(4);
        expect(lineIndentWidth("\t\tField:int = 1")).toBe(8);
        expect(lineIndentWidth("  \tField:int = 1")).toBe(6);
    });

    it("stops at the first non-whitespace character", () => {
        expect(lineIndentWidth("    Foo := class: # trailing")).toBe(4);
    });

    it("reads a whitespace-only line as its full width", () => {
        expect(lineIndentWidth("    ")).toBe(4);
        expect(lineIndentWidth("")).toBe(0);
    });

    it("does not count a CRLF carriage return as indentation", () => {
        expect(lineIndentWidth("  Foo := class:\r")).toBe(2);
    });
});

describe("popClosedBlocks", () => {
    it("leaves a deeper line inside every open block", () => {
        const open = [0, 4];
        popClosedBlocks(open, 8);
        expect(open).toEqual([0, 4]);
    });

    it("closes a block the line has returned to the indent of", () => {
        const open = [0, 4];
        popClosedBlocks(open, 4);
        expect(open).toEqual([0]);
    });

    it("closes every block a dedent has left, not just the innermost", () => {
        const open = [0, 4, 8];
        popClosedBlocks(open, 0);
        expect(open).toEqual([]);
    });

    it("is a no-op on an empty stack", () => {
        const open: number[] = [];
        popClosedBlocks(open, 0);
        expect(open).toEqual([]);
    });
});

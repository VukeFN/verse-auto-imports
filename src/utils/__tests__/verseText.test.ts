import { lineIndentWidth, popClosedBlocks } from "../verseText";

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

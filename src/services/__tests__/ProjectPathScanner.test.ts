import { ProjectPathScanner } from "../ProjectPathScanner";
import { ProjectPathNode } from "../../types";

/**
 * Regression tests for issue #282: the scanner's module pattern ended at `:`,
 * so a module written in either of the other two styles Verse gives a macro
 * body was dropped from the declaration cache entirely - the fall-through
 * variable pattern matched the `:` of `:=` and its guard then skipped the line
 * for naming `module`, leaving every reader of the cache blind to it.
 *
 * extractDeclarations is pure, so these run without the VS Code runtime.
 */
describe("ProjectPathScanner.extractDeclarations module forms", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;

    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const declare = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse");

    const moduleNames = (source: string): string[] =>
        declare(source)
            .filter((node) => node.type === "module")
            .map((node) => node.name);

    it("records a module whose brace opens on the declaration line", () => {
        expect(moduleNames("Inventory := module{}\n")).toEqual(["Inventory"]);
        expect(moduleNames("Inventory := module { }\n")).toEqual(["Inventory"]);
    });

    it("records a module whose brace opens on the following line", () => {
        expect(moduleNames("Inventory := module\n{\n    Count<public>:int = 0\n}\n")).toEqual(["Inventory"]);
    });

    it("records the module at the head of a dotted declaration", () => {
        // Only the head: the scan is line-anchored, so the second declaration
        // on the line is out of its reach either way.
        expect(moduleNames("Inventory := module. Item := module{}\n")).toEqual(["Inventory"]);
    });

    it("accepts the `>` terminator its sibling in ImportPathConverter accepts", () => {
        expect(moduleNames("Inventory := module>\n")).toEqual(["Inventory"]);
    });

    it("still records the colon form, and nests what a braced module contains", () => {
        expect(moduleNames("Inventory := module:\n    Count:int = 0\n")).toEqual(["Inventory"]);

        const nested = declare("Inventory := module {\n    Item := class {}\n}\n");
        expect(nested.map((node) => [node.type, node.fullPath])).toEqual([
            ["module", "Inventory"],
            ["class", "Inventory.Item"],
        ]);
    });

    it("keeps reading the visibility specifier attached to the name", () => {
        const [declared] = declare("Inventory<public> := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true, sourceLine: 1 });

        expect(moduleNames("Hidden<private> := module {}\n")).toEqual([]);
    });

    it("does not read a keyword that merely starts with module as a declaration", () => {
        expect(moduleNames("Inventory := modulex\n")).toEqual([]);
    });
});

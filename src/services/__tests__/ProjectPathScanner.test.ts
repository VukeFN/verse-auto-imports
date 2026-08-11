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

    const declareAll = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse", { includePrivate: true });

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

    it("leaves the members of a next-line brace module unnested", () => {
        // Pins the limit rather than endorsing it: indentation alone closes a
        // module, and the bare brace sits at the declaration's own indent, so
        // it pops the module before the body is read.
        const nested = declare("Inventory := module\n{\n    Item := class {}\n}\n");
        expect(nested.map((node) => [node.type, node.fullPath])).toEqual([
            ["module", "Inventory"],
            ["class", "Item"],
        ]);
    });

    it("keeps reading the visibility specifier attached to the name", () => {
        const [declared] = declare("Inventory<public> := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true, sourceLine: 1 });

        expect(moduleNames("Hidden<private> := module {}\n")).toEqual([]);
    });

    it("skips a module whose visibility entry runs past its keyword", () => {
        expect(moduleNames("Systems<scoped{ModuleA, ModuleB}> := module {}\n")).toEqual([]);
        expect(moduleNames("Systems<epic_internal> := module {}\n")).toEqual([]);
        expect(moduleNames("Systems<final><scoped{ModuleA}> := module {}\n")).toEqual([]);
    });

    it("reads a visibility padded inside its brackets", () => {
        const [declared] = declare("Inventory<  public  > := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true });
    });

    it("does not read a following specifier as the visibility entry's tail", () => {
        const [declared] = declare("Inventory<public><native> := module {}\n");
        expect(declared).toMatchObject({ name: "Inventory", type: "module", isPublic: true });
    });

    it("keeps a module carrying a named scope alias, which reads as no specifier", () => {
        // Pins the limit rather than endorsing it: `SharedScope := scoped{A, B}`
        // makes the specifier an ordinary identifier, indistinguishable from
        // <final> or any other non-visibility attribute without resolving the
        // alias, so the module is still offered as an import candidate that
        // does not compile.
        expect(moduleNames("Systems<SharedScope> := module {}\n")).toEqual(["Systems"]);
        expect(moduleNames("Systems<scoped_X> := module {}\n")).toEqual(["Systems"]);
    });

    it("drops a skipped module's descendants along with it", () => {
        // Every segment from the root has to be accessible for an import to
        // compile, so what a skipped module contains is exactly as unreachable
        // as the module itself. Recording the subtree without its enclosing
        // segment would offer a path that does not exist, and would collide
        // with a genuine top-level module of the same name.
        expect(declare("Systems<scoped{ModuleA}> := module:\n    Inner<public> := module:\n")).toEqual([]);
        expect(declare("Systems<private> := module:\n    Inner<public> := module:\n")).toEqual([]);
    });

    it("drops a skipped module's grandchildren too", () => {
        expect(declare("Systems<private> := module:\n    Inner<public> := module:\n        Deep<public> := class {}\n")).toEqual([]);
    });

    it("records a sibling declared after a skipped module closes", () => {
        const source = "Systems<private> := module:\n    Inner<public> := module:\n\nInventory<public> := module:\n    Item<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("keeps a skipped module's subtree, nested, when includePrivate lifts the skip", () => {
        const source = "Systems<private> := module:\n    Inner<public> := module:\n        Deep<public> := class {}\n";
        expect(declareAll(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Inner", "Systems.Inner.Deep"]);
    });

    it("does not read a keyword that merely starts with module as a declaration", () => {
        expect(moduleNames("Inventory := modulex\n")).toEqual([]);
    });
});

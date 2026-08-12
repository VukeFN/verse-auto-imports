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

    it("nests the members of a next-line brace module", () => {
        const nested = declare("Inventory := module\n{\n    Item := class {}\n}\n");
        expect(nested.map((node) => [node.type, node.fullPath])).toEqual([
            ["module", "Inventory"],
            ["class", "Inventory.Item"],
        ]);
    });

    it("closes a next-line brace module at its closing brace", () => {
        const source = "Inventory := module\n{\n    Item := class {}\n}\nLoose := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item", "Loose"]);
    });

    it("still waits for the brace across the blank lines and comments Verse allows before it", () => {
        const source = "Inventory := module\n\n# opening below\n{\n    Item := class {}\n}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("closes a module whose declaration line opened no body and no brace followed", () => {
        // Not valid Verse, so this pins degradation rather than a shape a user
        // can compile: the wait lasts one line, so a module missing its body
        // cannot swallow the rest of the file.
        const source = "Inventory := module\nLoose := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Loose"]);
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

    it("drops the subtree of a skipped module whose body opens on the next line", () => {
        // The brace form reaches the skip through a different route than the
        // colon form: the module has to survive its own opening brace before
        // the skip can hold its subtree at all.
        const source =
            "Systems<scoped{ModuleA}> := module\n{\n    Inner<public> := module\n    {\n        Deep<public> := class {}\n    }\n}\nInventory<public> := module:\n    Item<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("nests a kept module's subtree through a next-line brace body", () => {
        const source = "Systems<public> := module\n{\n    Inner<public> := module\n    {\n        Deep<public> := class {}\n    }\n}\nLoose<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Inner", "Systems.Inner.Deep", "Loose"]);
    });

    it("records a sibling declared after a skipped module closes", () => {
        const source = "Systems<private> := module:\n    Inner<public> := module:\n\nInventory<public> := module:\n    Item<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
    });

    it("resumes the enclosing module after a skipped one nested in it closes", () => {
        // The skipped entry is popped back to a kept parent rather than to an
        // empty stack, so a wrong pop bound shows up here as a missing `Outer.`
        // prefix instead of as a dropped declaration.
        const source = "Outer<public> := module:\n    Hidden<private> := module:\n        Deep<public> := class {}\n    Kept<public> := class {}\n";
        expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.Kept"]);
    });

    it("keeps a skipped module's subtree, nested, when includePrivate lifts the skip", () => {
        const source = "Systems<private> := module:\n    Inner<public> := module:\n        Deep<public> := class {}\n";
        expect(declareAll(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Inner", "Systems.Inner.Deep"]);
    });

    it("does not read a keyword that merely starts with module as a declaration", () => {
        expect(moduleNames("Inventory := modulex\n")).toEqual([]);
    });

    // Verse delimits a braced body by its braces alone, so its members may sit
    // at or left of the declaration's own indent - the Book of Verse writes it
    // that way in a compile-validated example. Closing such a module on
    // indentation lets its first member pop it, which promotes the whole body
    // to file scope: paths one segment short under a kept parent, and under a
    // skipped one a subtree the compiler rejects, offered beside any genuine
    // top-level module of the same name.
    describe("braced module bodies", () => {
        it("nests the members of a same-line brace body written at the module's own indent", () => {
            const source = "Systems<public> := module{\nB<public> := module:\n    X<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Systems.B.X", "Loose"]);
        });

        it("nests the members of a next-line brace body written at the module's own indent", () => {
            const source = "Systems<public> := module\n{\nB<public> := module:\n    X<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Systems.B.X", "Loose"]);
        });

        it("nests members written left of the declaration's own indent", () => {
            const source = "Outer<public> := module:\n    Inner<public> := module{\nX<public> := class {}\n    }\n    Kept<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Outer", "Outer.Inner", "Outer.Inner.X", "Outer.Kept"]);
        });

        it("drops the subtree of a skipped same-line brace module written at its own indent", () => {
            const source = "Systems<scoped{ModuleA}> := module{\nB<public> := module:\n    X<public> := class {}\n}\nInventory<public> := module:\n    Item<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
        });

        it("drops the subtree of a skipped next-line brace module written at its own indent", () => {
            const source = "Systems<scoped{ModuleA}> := module\n{\nB<public> := module:\n    X<public> := class {}\n}\nInventory<public> := module:\n    Item<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Inventory", "Inventory.Item"]);
        });

        it("closes each of a nested colon and brace module by its own rule", () => {
            // Both directions at once: a braced body holding a colon module,
            // that colon body holding a braced one. A rule leaking from either
            // to the other shows up here as a lost or a surplus segment.
            const source = "A<public> := module{\nB<public> := module:\n    C<public> := module{\nD<public> := class {}\n    }\n    E<public> := class {}\n}\nF<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["A", "A.B", "A.B.C", "A.B.C.D", "A.B.E", "F"]);
        });

        it("keeps a brace written as a char literal out of the depth", () => {
            // Masking cannot blank a char literal, because a single quote opens
            // an identifier's quoted suffix too. A brace cannot appear in such
            // a suffix, so one between quotes is always a literal, and counting
            // it would hold the module open for the rest of the file.
            const held = "Systems<public> := module{\nOpen<public>:char = '{'\nB<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(held).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Open", "Systems.B", "Loose"]);

            const closed = "Systems<public> := module{\nShut<public>:char = '}'\nB<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(closed).map((node) => node.fullPath)).toEqual(["Systems", "Systems.Shut", "Systems.B", "Loose"]);
        });

        it("keeps the brace of a using clause out of the depth that closes the module holding it", () => {
            // A braced `using` clause spans lines and is skipped a line at a
            // time, so counting its `}` without its `{` would close the module
            // around it one brace early.
            const source = "Systems<public> := module{\nusing{\n    /Verse.org/Simulation\n}\nB<public> := class {}\n}\nLoose<public> := class {}\n";
            expect(declare(source).map((node) => node.fullPath)).toEqual(["Systems", "Systems.B", "Loose"]);
        });
    });
});

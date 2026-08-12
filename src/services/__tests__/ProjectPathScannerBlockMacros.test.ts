import { ProjectPathScanner } from "../ProjectPathScanner";
import { ProjectPathNode } from "../../types";

/**
 * A Verse block macro reaches two of the declaration patterns: the fall-through
 * variable pattern needs only a name and a colon, which a bare `block:`
 * satisfies, and the function pattern needs a name, a parenthesised list and a
 * colon, which `if (X > 0):` satisfies. Either way one was recorded as a
 * declaration and offered downstream as an import candidate. Verse reserves
 * every one of those keywords, so none of them can name a declaration, whatever
 * shape follows it.
 *
 * extractDeclarations is pure, so these run without the VS Code runtime.
 */
describe("ProjectPathScanner.extractDeclarations block macros", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;

    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const declare = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse");

    const paths = (source: string): string[] => declare(source).map((node) => `${node.type}:${node.fullPath}`);

    // `X` is a function-local, which this scan records under the module path
    // because it tracks module nesting alone. That is the behaviour on either
    // side of the block macro guard, so it is asserted here rather than fixed.
    it("records the declarations in a function body and none of its block macros", () => {
        const source = [
            "Inventory := module:",
            "    Run<public>()<suspends>:void =",
            "        block:",
            "            X:int = 1",
            "        loop:",
            "            Sleep(1.0)",
            "        if:",
            "            true",
            "        then:",
            "            Print(:)",
            "        race:",
            "            Sleep(1.0)",
            "        sync:",
            "            Sleep(1.0)",
            "        branch:",
            "            Sleep(1.0)",
            "        defer:",
            "            Print(:)",
            "",
        ].join("\n");

        expect(paths(source)).toEqual(["module:Inventory", "function:Inventory.Run", "variable:Inventory.X"]);
    });

    // The container macros are the shape the issue reported: `array:` and
    // `map:` opening a block whose body is the literal's elements.
    it("records the declarations returning a container literal and neither container macro", () => {
        const source = ["Inventory := module:", "    Xs<public>():[]int =", "        array:", "            1", "    Ys<public>():[int]int =", "        map:", "            1 => 2", ""].join("\n");

        expect(paths(source)).toEqual(["module:Inventory", "function:Inventory.Xs", "function:Inventory.Ys"]);
    });

    it.each([
        "block",
        "loop",
        "if",
        "then",
        "else",
        "race",
        "rush",
        "sync",
        "branch",
        "defer",
        "spawn",
        "case",
        "for",
        "and",
        "or",
        "not",
        "option",
        "logic",
        "do",
        "array",
        "map",
        "assert",
        "let",
        "batch",
        "when",
        "first",
    ])("records no declaration for a bare `%s:`", (keyword) => {
        expect(paths(`Inventory := module:\n    ${keyword}:\n`)).toEqual(["module:Inventory"]);
    });

    // `do:` is not optional decoration on the block form of `first`: it is what
    // separates the iteration clauses from the body, so rejecting one word of
    // the pair and not the other leaves the construct half-handled. `X` is the
    // iteration binding, recorded under the module path for the reason the
    // first case above gives.
    it("records no declaration for either line of the `first:`/`do:` pair", () => {
        const source = ["Inventory := module:", "    Top<public>(Xs:[]int)<decides>:int =", "        first:", "            X : Xs", "            X > 0", "        do:", "            X", ""].join("\n");

        expect(paths(source)).toEqual(["module:Inventory", "function:Inventory.Top", "variable:Inventory.X"]);
    });

    it("records the declarations in a function body and none of its parenthesised block macros", () => {
        const source = [
            "Inventory := module:",
            "    Run<public>()<suspends>:void =",
            "        if (X > 0):",
            "            Print(:)",
            "        for (Item : Items):",
            "            Print(:)",
            "        case (X):",
            "            Print(:)",
            "",
        ].join("\n");

        expect(paths(source)).toEqual(["module:Inventory", "function:Inventory.Run"]);
    });

    // `if(X > 0)` carries no space, which is what the function pattern keys on:
    // a shape reaching it without one must be rejected too.
    it.each([
        "if (X > 0)",
        "if(X > 0)",
        "for (Item : Items)",
        "case (X)",
        "race (A, B)",
        "sync (A, B)",
        "branch (A)",
        "spawn (A)",
        "loop (A)",
        "when(X)",
        "when (X > 1 and Y < 10)",
        "first(I -> Y : Xs; X = Y)",
    ])("records no declaration for `%s:`", (head) => {
        expect(paths(`Inventory := module:\n    ${head}:\n`)).toEqual(["module:Inventory"]);
    });

    it("records a function whose name merely starts with one of them", () => {
        const source = ["Inventory := module:", "    ifMatches(X:int)<transacts>:logic = true", "    forEach(X:int):void = block:", "    caseOf(X:int):int = X", ""].join("\n");

        expect(paths(source)).toEqual(["module:Inventory", "function:Inventory.ifMatches", "function:Inventory.forEach", "function:Inventory.caseOf"]);
    });

    it("records a variable whose name is none of them", () => {
        expect(paths("Inventory := module:\n    Count:int = 0\n")).toEqual(["module:Inventory", "variable:Inventory.Count"]);
    });

    it("records a declaration whose name merely starts with one of them", () => {
        const source = [
            "Inventory := module:",
            "    blockCount:int = 1",
            "    ifState:logic = true",
            "    forEachItem:int = 2",
            "    arrayOf:int = 3",
            "    mapping:int = 4",
            "    assertion:logic = false",
            "    letter:int = 5",
            "    whenever:int = 6",
            "    firstly:int = 7",
            "    batched:int = 8",
            "    doOnce:logic = true",
            "",
        ].join("\n");

        expect(paths(source)).toEqual([
            "module:Inventory",
            "variable:Inventory.blockCount",
            "variable:Inventory.ifState",
            "variable:Inventory.forEachItem",
            "variable:Inventory.arrayOf",
            "variable:Inventory.mapping",
            "variable:Inventory.assertion",
            "variable:Inventory.letter",
            "variable:Inventory.whenever",
            "variable:Inventory.firstly",
            "variable:Inventory.batched",
            "variable:Inventory.doOnce",
        ]);
    });

    // Every ReservedFuture word the sweep for this set considered and left out.
    // Each is a block macro in every other respect, so what keeps it out is only
    // that Verse still lets a declaration carry the name.
    it.each(["profile", "await", "upon"])("records a variable named `%s`, which Verse has not yet reserved", (name) => {
        expect(paths(`Inventory := module:\n    ${name}:int = 5\n`)).toEqual(["module:Inventory", `variable:Inventory.${name}`]);
    });

    it("records a module-scope variable as before", () => {
        expect(paths("Count<public>:int = 0\n")).toEqual(["variable:Count"]);
    });
});

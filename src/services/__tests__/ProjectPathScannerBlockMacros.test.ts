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

    it.each(["block", "loop", "if", "then", "else", "race", "rush", "sync", "branch", "defer", "spawn", "case", "for", "and", "or", "not", "option", "logic"])(
        "records no declaration for a bare `%s:`",
        (keyword) => {
            expect(paths(`Inventory := module:\n    ${keyword}:\n`)).toEqual(["module:Inventory"]);
        },
    );

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

    it.each(["if (X > 0)", "for (Item : Items)", "case (X)", "race (A, B)", "sync (A, B)", "branch (A)", "spawn (A)", "loop (A)"])("records no declaration for `%s:`", (head) => {
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
        const source = ["Inventory := module:", "    blockCount:int = 1", "    ifState:logic = true", "    forEachItem:int = 2", ""].join("\n");

        expect(paths(source)).toEqual(["module:Inventory", "variable:Inventory.blockCount", "variable:Inventory.ifState", "variable:Inventory.forEachItem"]);
    });

    it("records a module-scope variable as before", () => {
        expect(paths("Count<public>:int = 0\n")).toEqual(["variable:Count"]);
    });
});

import { ProjectPathScanner } from "../ProjectPathScanner";
import { ProjectPathNode } from "../../types";

/**
 * The fall-through variable pattern needs only a name and a colon, which the
 * keyword opening a Verse block macro satisfies, so a `block:` written inside a
 * function body was recorded as a variable declaration and offered downstream
 * as an import candidate. Verse reserves every one of those keywords, so none
 * of them can name a declaration.
 *
 * extractDeclarations is pure, so these run without the VS Code runtime.
 */
describe("ProjectPathScanner.extractDeclarations block macros", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;

    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const declare = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse");

    const paths = (source: string): string[] => declare(source).map((node) => `${node.type}:${node.fullPath}`);

    it("records neither the block macros in a function body nor anything but the two real declarations", () => {
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

import { ProjectPathScanner } from "../ProjectPathScanner";
import { ProjectPathNode } from "../../types";

/**
 * Both directions matter to the cache's readers. A declaration recorded where
 * none exists resolves a module path the compiler never sees, and a phantom
 * module also prefixes the `fullPath` of every real declaration below it; a
 * real declaration hidden by a `#` inside a string is the same bug with the
 * sign flipped.
 *
 * extractDeclarations is pure, so these run without the VS Code runtime.
 */
describe("ProjectPathScanner.extractDeclarations comment and string masking", () => {
    type ScannerParams = ConstructorParameters<typeof ProjectPathScanner>;

    const scanner = new ProjectPathScanner({ appendLine: jest.fn() } as unknown as ScannerParams[0], {} as unknown as ScannerParams[1]);

    const declare = (source: string): ProjectPathNode[] => scanner.extractDeclarations(source, "Content/Inventory.verse");

    const names = (source: string): string[] => declare(source).map((node) => node.name);

    // The three single-line cases below already held before masking, because
    // every pattern is anchored and none of them starts with a word character.
    // They pin that, so a later scan that stops being line-anchored cannot
    // reopen the hole quietly.
    it("ignores a declaration commented out on one line with a block comment", () => {
        expect(names("<# Ghost := module {} #>\nInventory := module {}\n")).toEqual(["Inventory"]);
    });

    it("ignores declarations inside a multi-line block comment", () => {
        expect(names("<#\nGhost := module {}\nLegacy := class {}\n#>\nInventory := module {}\n")).toEqual(["Inventory"]);
    });

    it("ignores a declaration inside a nested block comment, which Verse allows", () => {
        expect(names("<# outer <# Ghost := class {} #> still comment #>\nInventory := module {}\n")).toEqual(["Inventory"]);
    });

    it("ignores a declaration after a `<#>` marker on the marker's own line", () => {
        // `<#>` opens the indented comment; it is not a block that closes on
        // the `#>` inside it, and read as one it leaves the declaration live.
        expect(names("<#> Ghost := module {}\nInventory := module {}\n")).toEqual(["Inventory"]);
    });

    it("ignores declarations in the indented body of a `<#>` marker, blank lines included", () => {
        expect(names("<#>\n    Ghost := module {}\n\n    Legacy := class {}\nInventory := module {}\n")).toEqual(["Inventory"]);
    });

    it("ends a `<#>` body at the first line back at the marker's indent", () => {
        expect(names("    <#>\n        Ghost := class {}\n    Inventory := module {}\n")).toEqual(["Inventory"]);
    });

    it("ignores a declaration after a `#` that does not start the line", () => {
        expect(names("Count:int = 0 # Ghost := class {}\nInventory := module {}\n")).toEqual(["Count", "Inventory"]);
    });

    it("does not let a `#` inside a string literal hide the declaration on that line", () => {
        // The default's closing `)` and the `:` after it are what the function
        // pattern matches on, and a `#` read as a line comment takes both.
        expect(names('Greet(Name:string = "a#b")<transacts>:void =\nInventory := module {}\n')).toEqual(["Greet", "Inventory"]);
        expect(names('Tag:string = "a#b"\nInventory := module {}\n')).toEqual(["Tag", "Inventory"]);
    });

    it("keeps a commented-out module out of the enclosing-module chain", () => {
        // The phantom is pushed onto the module stack as well as recorded, so
        // an unmasked scan reports the real class as `Ghost.Item`.
        const declared = declare("<#\nGhost := module:\n#>\n    Item := class {}\n");

        expect(declared.map((node) => [node.type, node.fullPath])).toEqual([["class", "Item"]]);
    });

    it("measures indentation on the unmasked line, so a comment before a declaration does not nest it", () => {
        // A comment in the leading columns masks to spaces. Read as
        // indentation it puts the declaration inside the module above.
        const declared = declare("Outer := module:\n    Inner := module:\n        Count:int = 0\n    <# note #> Sibling := module {}\n");

        expect(declared.map((node) => node.fullPath)).toEqual(["Outer", "Outer.Inner", "Outer.Inner.Count", "Outer.Sibling"]);
    });

    it("keeps the source line of a declaration below a block comment", () => {
        // Masking is space-for-character and keeps every newline. Anything
        // that blanked a comment wholesale would pass every test above and
        // still report this declaration on the wrong line.
        const declared = declare("<#\nGhost := module {}\n#>\nInventory := module {}\n").find((node) => node.name === "Inventory");

        expect(declared).toMatchObject({ sourceLine: 4 });
    });
});

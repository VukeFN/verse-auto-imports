import { findExplicitModuleDeclarations } from "../moduleDeclarations";

// Both directions matter to the caller. A declaration reported where none
// exists makes it edit dead text and believe the module is declared, so the
// compiler error stands; one missed makes it write a second part that can
// disagree with the real one.
describe("findExplicitModuleDeclarations comment and string masking", () => {
    it("ignores a declaration commented out with a block comment", () => {
        expect(findExplicitModuleDeclarations("<# Tools := module {} #>\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("ignores a declaration inside a multi-line block comment", () => {
        expect(findExplicitModuleDeclarations("<#\nTools := module {}\n#>\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("handles a nested block comment, which Verse allows", () => {
        expect(findExplicitModuleDeclarations("<# outer <# Tools := module {} #> still comment #>\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("ignores a declaration commented out with the `<#>` marker", () => {
        // `<#>` is the indented-comment marker, not a block that closes on the
        // `#>` inside it. Read as a block, it opens and shuts on itself and
        // leaves the declaration looking live.
        expect(findExplicitModuleDeclarations("<#> Tools := module {}\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("ignores the indented body of a `<#>` marker", () => {
        expect(findExplicitModuleDeclarations("<#>\n    Tools := module {}\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("keeps a blank line inside a `<#>` body", () => {
        expect(findExplicitModuleDeclarations("<#>\n    still comment\n\n    Tools := module {}\nReal := module {}\n").map((declaration) => declaration.name)).toEqual(["Real"]);
    });

    it("ends a `<#>` body at the first line back at the marker's indent", () => {
        expect(findExplicitModuleDeclarations("    <#>\n        hidden\n    Tools := module {}\n").map((declaration) => declaration.name)).toEqual(["Tools"]);
    });

    it("lets a `<#` inside a string open a comment, which Verse says it does", () => {
        expect(findExplicitModuleDeclarations('Note:string = "a<#b"\nTools := module {}\n')).toEqual([]);
    });

    it("still finds a declaration after a `#` inside a string literal", () => {
        const declarations = findExplicitModuleDeclarations('Tag:string = "a#b"\nTools := module {}\n');

        expect(declarations.map((declaration) => declaration.name)).toEqual(["Tools"]);
    });

    it("does not let a `#` inside a string on the declaration's own line hide it", () => {
        const content = 'Label:string = "#" ; Tools := module {}\n';
        const declarations = findExplicitModuleDeclarations(content);

        expect(declarations.map((declaration) => declaration.name)).toContain("Tools");
    });

    it("does not carry an unterminated string past its line", () => {
        expect(findExplicitModuleDeclarations('Broken:string = "oops\nTools := module {}\n').map((declaration) => declaration.name)).toEqual(["Tools"]);
    });

    it("treats an unterminated block comment as running to the end", () => {
        expect(findExplicitModuleDeclarations("<# open\nTools := module {}\n")).toEqual([]);
    });

    it("ignores a declaration inside a string literal", () => {
        expect(findExplicitModuleDeclarations('Snippet:string = "Tools := module {}"\n')).toEqual([]);
    });

    it("keeps offsets addressing the original text", () => {
        const content = "# a comment\nTools := module {}\n";
        const [declaration] = findExplicitModuleDeclarations(content);

        expect(content.slice(0, declaration.insertionPoint)).toBe("# a comment\nTools");
        expect(declaration.line).toBe(2);
    });

    it("does not treat an escaped quote as closing a string", () => {
        expect(findExplicitModuleDeclarations('Quote:string = "he said \\" Tools := module {} "\n')).toEqual([]);
    });
});

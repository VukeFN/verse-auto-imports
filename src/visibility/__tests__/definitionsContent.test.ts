import { appendDeclarationBlock, buildDeclarationBlock } from "../definitionsContent";

describe("buildDeclarationBlock", () => {
    it("writes a single module in the brace style, which needs no body", () => {
        expect(buildDeclarationBlock([{ name: "Tools", specifier: "public" }])).toBe("Tools<public> := module {}");
    });

    it("nests each module in the one above it", () => {
        expect(buildDeclarationBlock([{ name: "Gadgets" }, { name: "Deep", specifier: "public" }, { name: "Tools", specifier: "public" }])).toBe(
            "Gadgets := module:\n    Deep<public> := module:\n        Tools<public> := module {}",
        );
    });

    it("leaves a scaffolding parent bare, so it stays internal", () => {
        expect(buildDeclarationBlock([{ name: "Gadgets" }, { name: "Tools", specifier: "public" }])).toBe("Gadgets := module:\n    Tools<public> := module {}");
    });

    it("writes whatever specifier it is given, not only public", () => {
        expect(
            buildDeclarationBlock([
                { name: "Gadgets", specifier: "internal" },
                { name: "Tools", specifier: "public" },
            ]),
        ).toBe("Gadgets<internal> := module:\n    Tools<public> := module {}");
    });
});

describe("appendDeclarationBlock", () => {
    it("writes the block alone into an empty file", () => {
        expect(appendDeclarationBlock("", "Tools<public> := module {}")).toBe("Tools<public> := module {}\n");
    });

    it("separates the block from existing content with one blank line", () => {
        expect(appendDeclarationBlock("A := module {}\n", "B<public> := module {}")).toBe("A := module {}\n\nB<public> := module {}\n");
    });

    it("collapses whatever trailing whitespace the file had", () => {
        expect(appendDeclarationBlock("A := module {}\n\n\n\n", "B<public> := module {}")).toBe("A := module {}\n\nB<public> := module {}\n");
    });

    it("keeps the file's CRLF line endings", () => {
        expect(appendDeclarationBlock("A := module {}\r\n", "B := module:\n    C<public> := module {}")).toBe("A := module {}\r\n\r\nB := module:\r\n    C<public> := module {}\r\n");
    });
});

import { appendDeclarationBlock, buildDeclarationBlock, nestDeclarationEdit } from "../definitionsContent";
import { findExplicitModuleDeclarations, ModuleDeclaration } from "../moduleDeclarations";

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

describe("nestDeclarationEdit", () => {
    /** The declaration of that name in the content, read exactly as the scan reads it. */
    const anchorNamed = (content: string, name: string): ModuleDeclaration => {
        const declaration = findExplicitModuleDeclarations(content).find((candidate) => candidate.name === name);
        if (!declaration) {
            throw new Error(`no declaration of '${name}' in the fixture`);
        }
        return declaration;
    };

    /** The content with the edit applied, which is what the writer folds into its replace. */
    const applied = (content: string, name: string, segments: Parameters<typeof nestDeclarationEdit>[2]): string | null => {
        const edit = nestDeclarationEdit(content, anchorNamed(content, name), segments);
        return edit === null ? null : content.slice(0, edit.span.start) + edit.text + content.slice(edit.span.end);
    };

    it("inserts the chain as a colon body's new first child", () => {
        expect(applied("Gadgets := module:\n    Deep := module {}\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBe(
            "Gadgets := module:\n    Tools<public> := module {}\n    Deep := module {}\n",
        );
    });

    it("copies the body's own indentation byte for byte, stepping deeper from there", () => {
        // The compiler compares block indentation as a byte-wise prefix, so a
        // computed width would break a file indented differently than ours.
        expect(applied("Gadgets := module:\n  Deep := module {}\n", "Gadgets", [{ name: "Sub" }, { name: "Tools", specifier: "public" }])).toBe(
            "Gadgets := module:\n  Sub := module:\n      Tools<public> := module {}\n  Deep := module {}\n",
        );
    });

    it("reads the body indent past blank lines, which stay inside the block", () => {
        expect(applied("Gadgets := module:\n\n    Deep := module {}\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBe(
            "Gadgets := module:\n    Tools<public> := module {}\n\n    Deep := module {}\n",
        );
    });

    it("converts an empty-brace leaf to a colon body, keeping its specifier", () => {
        expect(applied("Gadgets := module:\n    Tools<public> := module {}\n", "Tools", [{ name: "More", specifier: "public" }])).toBe(
            "Gadgets := module:\n    Tools<public> := module:\n        More<public> := module {}\n",
        );
    });

    it("keeps the file's CRLF line endings", () => {
        expect(applied("Gadgets := module:\r\n    Deep := module {}\r\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBe(
            "Gadgets := module:\r\n    Tools<public> := module {}\r\n    Deep := module {}\r\n",
        );
    });

    it("appends a body to a colon head the file ends on without a newline", () => {
        expect(applied("Gadgets := module:", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBe("Gadgets := module:\n    Tools<public> := module {}\n");
    });

    it("declines the dotted form, whose body it cannot place", () => {
        expect(applied("Gadgets := module. X:int = 1\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBeNull();
    });

    it("declines a brace body holding content", () => {
        expect(applied("Gadgets := module { X:int = 1 }\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBeNull();
    });

    it("declines trailing text after the empty braces", () => {
        expect(applied("Gadgets := module {} # note\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBeNull();
    });

    it("declines trailing text after the colon", () => {
        expect(applied("Gadgets := module: # note\n    Deep := module {}\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBeNull();
    });

    it("declines a brace opening on its own line, which leaves no head for the colon", () => {
        expect(applied("Gadgets := module\n{\n}\n", "Gadgets", [{ name: "Tools", specifier: "public" }])).toBeNull();
    });
});

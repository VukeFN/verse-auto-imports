import * as fs from "fs";
import * as path from "path";
import { parseDigestContent, rootDomainForDigestFile } from "../digestParsing";
import { BUNDLED_DIGEST_NAMES, digestSourceFile } from "../digestManifest";
import { lineIndentWidth } from "../../utils/verseText";

/**
 * Refresh-time invariant sweep over the bundled `.verse` digests.
 *
 * Every other digest test pins hand-picked identifiers, so it holds only for the
 * names someone thought to list. These assertions hold for every declaration in
 * all three bundled digests, so a refresh carrying a shape the parser mishandles
 * fails here rather than reaching `src/data`.
 *
 * What the walk below buys, and what it does not, because the difference is easy
 * to overread: it re-derives head recognition rather than calling the parser, so
 * it catches a regression in `matchParametricTypeHead`. It does NOT catch a
 * declaration shape that it and the parser misread alike, because it encodes the
 * same head grammar - a paren inside a string literal on the head line is one.
 * Closing that gap needs a rule taken from the compiler grammar, not a second
 * reading of the same digests.
 *
 * The leak check compares names rather than declaration lines, a `DigestEntry`
 * carrying no line number. A member whose name also occurs at module scope
 * elsewhere in the same file is therefore invisible to it.
 */

const UTILS_DIR = path.resolve(__dirname, "..", "..", "utils");

/** A scope qualifier prefix such as `(/Verse.org/Chat:)`, which precedes the declared name. */
const QUALIFIER = /^\((\/[^()]*):\)/;

/** The leading identifier of a declaration, with any specifier groups. */
const LEADING_NAME = /^(\w+)((?:<[^>]+>)*)/;

/** A type head with no type-parameter list: `name<...> := class(...):`. */
const PLAIN_TYPE = /^\w+(?:<[^>]+>)*\s*:=\s*(module|class|struct|interface|enum)\b/;

/** A parametric head's opening: the name, its specifiers, and the `(` of its parameter list. */
const PARAM_HEAD = /^(\w+)((?:<[^>]+>)*)\(/;

/** What must follow a parametric head's parameter list for it to be a type. */
const PARAM_TAIL = /^\s*:=\s*(module|class|struct|interface|enum)\b/;

interface ParametricHead {
    name: string;
    keyword: string;
    line: number;
}

interface DigestWalk {
    /** Identifiers declared on a line that no class/struct/interface/enum body encloses. */
    moduleScopeNames: Set<string>;
    /** Every parametric type head found at module scope. */
    parametricHeads: ParametricHead[];
}

/**
 * The keyword a parametric head declares, or null where the line does not open
 * one. Walks the parameter list for its matching `)` so nesting of any depth is
 * spanned, then requires `:=` and a declaration keyword after it.
 */
function parametricKeyword(work: string): string | null {
    const head = work.match(PARAM_HEAD);
    if (!head) {
        return null;
    }

    let depth = 0;
    let index = head[0].length - 1;
    for (; index < work.length; index++) {
        if (work[index] === "(") {
            depth++;
        } else if (work[index] === ")") {
            depth--;
            if (depth === 0) {
                index++;
                break;
            }
        }
    }
    if (depth !== 0) {
        return null;
    }

    const tail = work.slice(index).match(PARAM_TAIL);
    return tail ? tail[1] : null;
}

/**
 * Walks one digest's raw text, tracking which lines a type body encloses. A type
 * body is the lines indented past its head, so a line back at or inside the
 * head's own indent closes it.
 */
function walkDigest(content: string): DigestWalk {
    const moduleScopeNames = new Set<string>();
    const parametricHeads: ParametricHead[] = [];
    const typeBodyIndents: number[] = [];

    let lineNumber = 0;
    for (const rawLine of content.split("\n")) {
        lineNumber++;
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#") || line.startsWith("@") || line.startsWith("using")) {
            continue;
        }

        const indent = lineIndentWidth(rawLine);
        while (typeBodyIndents.length > 0 && indent <= typeBodyIndents[typeBodyIndents.length - 1]) {
            typeBodyIndents.pop();
        }
        if (typeBodyIndents.length > 0) {
            continue; // A member, not a module-scope declaration.
        }

        let work = line;
        const qualifier = line.match(QUALIFIER);
        if (qualifier) {
            work = line.slice(qualifier[0].length);
        } else if (line.startsWith("(")) {
            continue; // Receiver-style extension method.
        }

        const named = work.match(LEADING_NAME);
        if (!named || named[1] === "") {
            continue;
        }
        moduleScopeNames.add(named[1]);

        const parametric = parametricKeyword(work);
        if (parametric) {
            parametricHeads.push({ name: named[1], keyword: parametric, line: lineNumber });
            if (parametric !== "module") {
                typeBodyIndents.push(indent);
            }
            continue;
        }

        const plain = work.match(PLAIN_TYPE);
        if (plain && plain[1] !== "module") {
            typeBodyIndents.push(indent);
        }
    }

    return { moduleScopeNames, parametricHeads };
}

describe.each(BUNDLED_DIGEST_NAMES)("bundled digest invariants (%s)", (digestName) => {
    const fileName = digestSourceFile(digestName);
    const content = fs.readFileSync(path.join(UTILS_DIR, fileName), "utf8");
    const { entries } = parseDigestContent(content, rootDomainForDigestFile(fileName));
    const { moduleScopeNames, parametricHeads } = walkDigest(content);

    it("classifies every parametric type head as a type", () => {
        // A head whose parameter list the parser cannot span falls through to the
        // plain declaration branch and is recorded as a function.
        expect(parametricHeads.length).toBeGreaterThan(0);

        // A name can carry a declaration per module, so the head is classified
        // correctly as long as one of them bears the expected type.
        const misclassified = parametricHeads
            .filter((head) => entries[head.name] !== undefined)
            .filter((head) => {
                const expected = head.keyword === "module" ? "module" : "class";
                return !entries[head.name].some((declaration) => declaration.type === expected);
            })
            .map(
                (head) =>
                    `${fileName}:${head.line} ${head.name} recorded as ${entries[head.name].map((declaration) => declaration.type).join("/")}, expected ${head.keyword === "module" ? "module" : "class"}`,
            );

        expect(misclassified).toEqual([]);
    });

    it("records no identifier that only a type body declares", () => {
        // A head that never opened its body leaks the members indented under it,
        // and each leaked name resolves as a high-confidence import for an
        // identifier the user never declared.
        const leaked = Object.keys(entries).filter((identifier) => !moduleScopeNames.has(identifier));

        expect(leaked).toEqual([]);
    });
});

import * as fs from "fs";
import * as path from "path";
import { parseDigestContent, rootDomainForDigestFile } from "../digestParsing";
import { BUNDLED_DIGEST_NAMES, digestSourceFile } from "../digestManifest";

/**
 * Refresh-time invariant sweep over the bundled `.verse` digests.
 *
 * Every other digest test pins hand-picked identifiers, which is why the parser
 * shipped four misparsed parametric heads and eight leaked members while its
 * "records parametric types but not their members" test stayed green. These
 * assertions instead hold for every declaration in every bundled digest, so a
 * future Epic drop carrying a shape the parser does not handle fails here rather
 * than reaching `src/data`.
 *
 * The walk below is deliberately a second, independent implementation. Deriving
 * the expectation from the parser under test would only restate whatever the
 * parser does, which is the failure mode this file exists to catch. It stays
 * coarse on purpose: it reads any module-scope line as declaring its leading
 * identifier, so it can only ever admit more names than the parser should, never
 * fewer.
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

function indentWidth(rawLine: string): number {
    let width = 0;
    for (const character of rawLine) {
        if (character === " ") {
            width += 1;
        } else if (character === "\t") {
            width += 4;
        } else {
            break;
        }
    }
    return width;
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

        const indent = indentWidth(rawLine);
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

        const misclassified = parametricHeads
            .filter((head) => entries[head.name] !== undefined)
            .filter((head) => entries[head.name].type !== (head.keyword === "module" ? "module" : "class"))
            .map((head) => `${fileName}:${head.line} ${head.name} recorded as ${entries[head.name].type}, expected ${head.keyword === "module" ? "module" : "class"}`);

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

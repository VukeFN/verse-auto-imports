import { AssetsDigestParser } from "../../services/AssetsDigestParser";
import { parseDigestContent } from "../../services/digestParsing";
import { ProjectPathScanner } from "../../services/ProjectPathScanner";
import { DeclarationHead, matchDeclarationHead } from "../verseDeclarationHead";

/**
 * One probe corpus read by every caller of the declaration-head matcher, so a
 * grammar rule learned in one of them cannot quietly go unlearned in the others.
 *
 * Each probe is a construct the three matchers this replaced disagreed about,
 * and each is asserted twice: once that the shared matcher's answer is the
 * language's, cited below to the compiler grammar or to a compile-validated
 * book test, and once that every caller reports exactly what its own policy
 * says about that answer. The second half is what a future divergence trips
 * over - a rule added to one caller and not the shared matcher fails here even
 * where nobody thought to write the case down.
 *
 * The two halves are independent. A probe whose head is wrong fails the first;
 * a caller that re-decides the grammar for itself fails the second.
 */

const scanner = new ProjectPathScanner(
    { appendLine: jest.fn() } as unknown as ConstructorParameters<typeof ProjectPathScanner>[0],
    {} as unknown as ConstructorParameters<typeof ProjectPathScanner>[1],
);

/** The part of a head the callers' policies turn on. */
interface HeadShape {
    name: string;
    keyword: DeclarationHead["keyword"];
    hasParams: boolean;
    hasReceiver: boolean;
}

function shapeOf(head: DeclarationHead | null): HeadShape | null {
    return head && { name: head.name, keyword: head.keyword, hasParams: head.params !== null, hasReceiver: head.receiver !== null };
}

/**
 * What each caller's documented policy makes of a head, written once so the
 * expectations below are derived from the shared grammar rather than restated
 * per caller - restating them is how three matchers drifted apart in the first
 * place.
 *
 * The two `false` answers are the deliberate divergences, and they are policy
 * rather than grammar: all three callers see the same head and choose.
 */
function policy(head: DeclarationHead | null, line: string): { digest: boolean; assets: boolean; scanner: boolean } {
    if (!head) {
        return { digest: false, assets: false, scanner: false };
    }
    const isExternalInstance = head.operator === ":" && /^\s*\w+\s*=\s*external\b/.test(line.slice(head.end));
    return {
        // The API digest index declines receiver-style extension methods.
        digest: head.receiver === null,
        // The assets parser wants asset type names only: a class, a struct, or
        // an `external` instance at module scope.
        assets: head.receiver === null && (head.keyword === "class" || head.keyword === "struct" || isExternalInstance),
        // The project scan indexes every declaration, extension methods included.
        scanner: true,
    };
}

/** The names each caller records, in the order it records them. */
function reported(source: string): { digest: string[]; assets: string[]; scanner: string[] } {
    return {
        digest: Object.keys(parseDigestContent(source, "/mygame@fortnite.com/mygame").entries),
        assets: AssetsDigestParser.parseDigestContent(source),
        scanner: scanner.extractDeclarations(source, "declarations.verse").map((node) => node.name),
    };
}

interface Probe {
    /** What the construct is, phrased as the rule it tests. */
    name: string;
    source: string;
    /** The head the language gives this line. */
    head: HeadShape;
}

const probes: Probe[] = [
    {
        // ProjectPathScanner allowed one specifier group after `enum` where it
        // allowed any number after `class`. Two are `assert_valid` at book
        // Tests/CompatibilityConstraints.versetest:1147.
        name: "an enum takes as many specifier groups on its keyword as a class does",
        source: "Colour<public> := enum<open><persistable>:\n",
        head: { name: "Colour", keyword: "enum", hasParams: false, hasReceiver: false },
    },
    {
        name: "an enum with one keyword specifier is the same rule",
        source: "Colour<public> := enum<open>:\n",
        head: { name: "Colour", keyword: "enum", hasParams: false, hasReceiver: false },
    },
    {
        // ProjectPathScanner's enum required a `:`, so a braced body was
        // dropped. Braced enums are book Tests/Any.versetest:5 and
        // Tests/Attributes/available.versetest:40.
        name: "an enum body opens with a brace as readily as with a colon",
        source: "Colour<public> := enum<open> { A, B }\n",
        head: { name: "Colour", keyword: "enum", hasParams: false, hasReceiver: false },
    },
    {
        // `\([^)]*\)` cannot cross the inner `)`, so ProjectPathScanner dropped
        // the whole declaration. `Paren := '(' List ')' Space` makes a parameter
        // an expression, so the list nests to any depth and must be walked.
        name: "a parameter list nests, and is walked rather than matched",
        source: "GetComponent<public>(component_type:castable_subtype(component))<transacts>:void = external {}\n",
        head: { name: "GetComponent", keyword: null, hasParams: true, hasReceiver: false },
    },
    {
        // A type-parameter list before the `:=`. digestParsing walked it;
        // ProjectPathScanner had no pattern for it at all.
        name: "a type-parameter list precedes the declaration keyword",
        source: "Pair<public>(t:subtype(comparable)) := class:\n",
        head: { name: "Pair", keyword: "class", hasParams: true, hasReceiver: false },
    },
    {
        // The kept divergence: one head, two policies. The receiver is walked
        // for its matching `)` like any other paren group.
        name: "a receiver-style extension method is one head the callers answer differently",
        source: "(Prop:creative_prop).Method<public>()<transacts>:void = external {}\n",
        head: { name: "Method", keyword: null, hasParams: true, hasReceiver: true },
    },
    {
        // #373's C-04. A keyword that only prefixes the identifier opens no
        // body, so the line declares a variable and is not dropped either - the
        // two ways this has been got wrong.
        name: "a keyword that merely prefixes an identifier declares no type",
        source: "Items<public> := classify_items(X)\n",
        head: { name: "Items", keyword: null, hasParams: false, hasReceiver: false },
    },
    {
        name: "a class takes stacked keyword specifiers and a superclass list",
        source: "Thing<public> := class<abstract><castable>(base_device):\n",
        head: { name: "Thing", keyword: "class", hasParams: false, hasReceiver: false },
    },
    {
        name: "a class body opens with a brace",
        source: "Thing<public> := class { }\n",
        head: { name: "Thing", keyword: "class", hasParams: false, hasReceiver: false },
    },
    {
        // Four groups, as shipped in Verse.digest.verse.
        name: "specifier groups stack without bound",
        source: "Point<public> := struct<concrete><computes><persistable><uht_comparable>:\n",
        head: { name: "Point", keyword: "struct", hasParams: false, hasReceiver: false },
    },
    {
        name: "an interface is the same head as a class",
        source: "Shape<public> := interface<epic_internal>:\n",
        head: { name: "Shape", keyword: "interface", hasParams: false, hasReceiver: false },
    },
    {
        name: "a module declares with a colon",
        source: "Inner<public> := module:\n",
        head: { name: "Inner", keyword: "module", hasParams: false, hasReceiver: false },
    },
    {
        // The brace opens on the line below, which is the only reason a head
        // ending at the line end is a declaration and not a fragment.
        name: "a module whose brace opens on the next line is still a module",
        source: "Inner<public> := module\n{\n}\n",
        head: { name: "Inner", keyword: "module", hasParams: false, hasReceiver: false },
    },
    {
        name: "an external instance is a typed name, not a keyword declaration",
        source: "image1<public>:texture = external {}\n",
        head: { name: "image1", keyword: null, hasParams: false, hasReceiver: false },
    },
    {
        name: "a typed constant declares a variable",
        source: "Score<public>:int = 0\n",
        head: { name: "Score", keyword: null, hasParams: false, hasReceiver: false },
    },
    {
        name: "an inferred constant declares a variable",
        source: "Total<public> := 5\n",
        head: { name: "Total", keyword: null, hasParams: false, hasReceiver: false },
    },
];

describe("the one declaration-head grammar", () => {
    for (const probe of probes) {
        it(`${probe.name}: the head is the language's answer`, () => {
            expect(shapeOf(matchDeclarationHead(probe.source.split("\n")[0].trim()))).toEqual(probe.head);
        });
    }
});

describe("every caller reads that grammar and adds only its own policy", () => {
    for (const probe of probes) {
        it(`${probe.name}: each caller reports what its policy says, and nothing else`, () => {
            const line = probe.source.split("\n")[0].trim();
            const expected = policy(matchDeclarationHead(line), line);
            expect(reported(probe.source)).toEqual({
                digest: expected.digest ? [probe.head.name] : [],
                assets: expected.assets ? [probe.head.name] : [],
                scanner: expected.scanner ? [probe.head.name] : [],
            });
        });
    }
});

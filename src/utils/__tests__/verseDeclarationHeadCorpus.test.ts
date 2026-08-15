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
    operator: DeclarationHead["operator"];
    hasParams: boolean;
    hasReceiver: boolean;
}

function shapeOf(head: DeclarationHead | null): HeadShape | null {
    return head && { name: head.name, keyword: head.keyword, operator: head.operator, hasParams: head.params !== null, hasReceiver: head.receiver !== null };
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
    /**
     * Which callers record the declared name, written out rather than derived
     * from the callers' own policy code.
     *
     * Deriving it was tried and is what let a widened `assets` rule ship: an
     * oracle that recomputes what it is checking agrees with the bug. Both
     * halves of this corpus are authored, so the second can fail while the
     * first passes.
     */
    reports: { digest: boolean; assets: boolean; scanner: boolean };
}

/** Records in the digest index and the project scan, but is no asset type. */
const NOT_AN_ASSET_TYPE = { digest: true, assets: false, scanner: true };

/** Records everywhere: a class or struct is an asset type name too. */
const EVERYWHERE = { digest: true, assets: true, scanner: true };

const probes: Probe[] = [
    {
        // ProjectPathScanner allowed one specifier group after `enum` where it
        // allowed any number after `class`. Two are `assert_valid` at book
        // Tests/CompatibilityConstraints.versetest:1147.
        name: "an enum takes as many specifier groups on its keyword as a class does",
        source: "Colour<public> := enum<open><persistable>:\n",
        head: { name: "Colour", keyword: "enum", operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        name: "an enum with one keyword specifier is the same rule",
        source: "Colour<public> := enum<open>:\n",
        head: { name: "Colour", keyword: "enum", operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        // ProjectPathScanner's enum required a `:`, so a braced body was
        // dropped. Braced enums are book Tests/Any.versetest:5 and
        // Tests/Attributes/available.versetest:40.
        name: "an enum body opens with a brace as readily as with a colon",
        source: "Colour<public> := enum<open> { A, B }\n",
        head: { name: "Colour", keyword: "enum", operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        // `\([^)]*\)` cannot cross the inner `)`, so ProjectPathScanner dropped
        // the whole declaration. `Paren := '(' List ')' Space` makes a parameter
        // an expression, so the list nests to any depth and must be walked.
        name: "a parameter list nests, and is walked rather than matched",
        source: "GetComponent<public>(component_type:castable_subtype(component))<transacts>:void = external {}\n",
        head: { name: "GetComponent", keyword: null, operator: ":", hasParams: true, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        // A function's tail is an asset instance's tail exactly, so only the
        // parameter list separates them. Recording one as an asset type name
        // moves where a dotted suggestion is split into module and class.
        name: "a module-scope function ending in `= external` is not an asset instance",
        source: "GetColor<public>()<transacts>:vector3 = external {}\n",
        head: { name: "GetColor", keyword: null, operator: ":", hasParams: true, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        // A type-parameter list before the `:=`. digestParsing walked it;
        // ProjectPathScanner had no pattern for it at all.
        name: "a type-parameter list precedes the declaration keyword",
        source: "Pair<public>(t:subtype(comparable)) := class:\n",
        head: { name: "Pair", keyword: "class", operator: ":=", hasParams: true, hasReceiver: false },
        reports: EVERYWHERE,
    },
    {
        // The kept divergence: one head, two policies. The receiver is walked
        // for its matching `)` like any other paren group.
        name: "a receiver-style extension method is one head the callers answer differently",
        source: "(Prop:creative_prop).Method<public>()<transacts>:void = external {}\n",
        head: { name: "Method", keyword: null, operator: ":", hasParams: true, hasReceiver: true },
        reports: { digest: false, assets: false, scanner: true },
    },
    {
        // The other kept divergence. In a digest an unclosed `(` can only be a
        // signature wrapping to the next line; in project source it is far more
        // often a call wrapping inside a body, so the scan declines it. The
        // test below this corpus carries that second reading in full.
        name: "an unclosed parameter list is a signature to one caller and a statement to another",
        source: "WrapFunc<public>(\n",
        head: { name: "WrapFunc", keyword: null, operator: "(", hasParams: false, hasReceiver: false },
        reports: { digest: true, assets: false, scanner: false },
    },
    {
        // A keyword that only prefixes the identifier opens no body, so the
        // line declares a variable - and is not dropped either, which is the
        // other way this has been got wrong.
        name: "a keyword that merely prefixes an identifier declares no type",
        source: "Items<public> := classify_items(X)\n",
        head: { name: "Items", keyword: null, operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        name: "a class takes stacked keyword specifiers and a superclass list",
        source: "Thing<public> := class<abstract><castable>(base_device):\n",
        head: { name: "Thing", keyword: "class", operator: ":=", hasParams: false, hasReceiver: false },
        reports: EVERYWHERE,
    },
    {
        name: "a class body opens with a brace",
        source: "Thing<public> := class { }\n",
        head: { name: "Thing", keyword: "class", operator: ":=", hasParams: false, hasReceiver: false },
        reports: EVERYWHERE,
    },
    {
        // Four groups, as shipped in Verse.digest.verse.
        name: "specifier groups stack without bound",
        source: "Point<public> := struct<concrete><computes><persistable><uht_comparable>:\n",
        head: { name: "Point", keyword: "struct", operator: ":=", hasParams: false, hasReceiver: false },
        reports: EVERYWHERE,
    },
    {
        name: "an interface is the same head as a class",
        source: "Shape<public> := interface<epic_internal>:\n",
        head: { name: "Shape", keyword: "interface", operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        name: "a module declares with a colon",
        source: "Inner<public> := module:\n",
        head: { name: "Inner", keyword: "module", operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        // The brace opens on the line below, which is the only reason a head
        // ending at the line end is a declaration and not a fragment.
        name: "a module whose brace opens on the next line is still a module",
        source: "Inner<public> := module\n{\n}\n",
        head: { name: "Inner", keyword: "module", operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        name: "an external instance is a typed name, not a keyword declaration",
        source: "image1<public>:texture = external {}\n",
        head: { name: "image1", keyword: null, operator: ":", hasParams: false, hasReceiver: false },
        reports: EVERYWHERE,
    },
    {
        name: "a typed constant declares a variable",
        source: "Score<public>:int = 0\n",
        head: { name: "Score", keyword: null, operator: ":", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
    },
    {
        name: "an inferred constant declares a variable",
        source: "Total<public> := 5\n",
        head: { name: "Total", keyword: null, operator: ":=", hasParams: false, hasReceiver: false },
        reports: NOT_AN_ASSET_TYPE,
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
            expect(reported(probe.source)).toEqual({
                digest: probe.reports.digest ? [probe.head.name] : [],
                assets: probe.reports.assets ? [probe.head.name] : [],
                scanner: probe.reports.scanner ? [probe.head.name] : [],
            });
        });
    }
});

describe("a statement inside a function body declares nothing", () => {
    // The realistic shape behind the unclosed-parameter-list probe: project
    // source holds statements, and a call wrapping across lines opens a `(`
    // that its own line never closes.
    const source = ["my_device<public> := class(creative_device):", "    OnBegin<override>()<suspends>:void=", "        SpawnProp(", "            Asset,", "            Position)", ""].join("\n");

    it("the project scan records the class and its method, and neither line of the call", () => {
        expect(scanner.extractDeclarations(source, "declarations.verse").map((node) => `${node.type}:${node.name}`)).toEqual(["class:my_device", "function:OnBegin"]);
    });
});

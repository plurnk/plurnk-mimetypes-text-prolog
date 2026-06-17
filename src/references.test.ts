import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextProlog from "./TextProlog.ts";

const metadata = { mimetype: "text/x-prolog", glyph: "🧩", extensions: [".pl", ".pro", ".prolog"] };
const h = () => new TextProlog(metadata);

// A real Prolog program is a call graph: a clause BODY's goals reference
// predicates, and those references join to predicate DEFINITIONS (clause heads).
// `ancestor` and `parent` are defined and called locally — the in-corpus edges.
// `write`, `nl`, `member`, `findall` are builtins: honest dead rows.
const SRC = [
    ":- module(family, [parent/2, ancestor/2, sibling/2]).",
    "",
    "% frobnicate the widget",
    "parent(alice, bob).",
    "parent(bob, charlie).",
    "",
    "ancestor(X, Y) :- parent(X, Y).",
    "ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).",
    "",
    "sibling(X, Y) :- parent(P, X), parent(P, Y), X \\= Y.",
    "",
    "describe(X) :- ( parent(X, _) ; ancestor(X, _) ).",
    "",
    "orphan(X) :- \\+ parent(_, X).",
    "",
    "report(L) :- findall(X, parent(X, _), L), write('done'), nl.",
].join("\n");

describe("TextProlog — references (call graph)", () => {
    it("body goals are `call` edges scoped to the clause head predicate", () => {
        const refs = h().references(SRC);
        // ancestor's recursive rule calls parent and ancestor.
        assert.ok(refs.some((r) => r.name === "parent" && r.kind === "call" && r.container === "ancestor"));
        assert.ok(refs.some((r) => r.name === "ancestor" && r.kind === "call" && r.container === "ancestor"));
        // sibling calls parent twice.
        assert.equal(
            refs.filter((r) => r.name === "parent" && r.container === "sibling").length,
            2,
            "two parent goals in sibling's body",
        );
    });

    it("descends disjunction `(a ; b)` into both branches", () => {
        const refs = h().references(SRC);
        assert.ok(refs.some((r) => r.name === "parent" && r.container === "describe"));
        assert.ok(refs.some((r) => r.name === "ancestor" && r.container === "describe"));
    });

    it("descends negation `\\+ G` into the goal", () => {
        const refs = h().references(SRC);
        assert.ok(refs.some((r) => r.name === "parent" && r.container === "orphan"));
    });

    it("a meta-call surfaces the meta-predicate, not the goal in its argument", () => {
        const refs = h().references(SRC);
        // report/1 calls findall — but the p(X)-style goal riding in findall's
        // argument (parent(X,_)) is a term, not a structural goal: precision.
        assert.ok(refs.some((r) => r.name === "findall" && r.container === "report"));
        assert.ok(!refs.some((r) => r.name === "parent" && r.container === "report"));
    });

    it("operator goals (X \\= Y) are not predicate calls", () => {
        const refs = h().references(SRC);
        assert.ok(!refs.some((r) => r.name === "\\=" || r.name === "="));
    });

    it("does not emit the clause head predicate as a ref (that's the def)", () => {
        const refs = h().references(SRC);
        // parent's own facts/heads are defs; no `call parent` sits at a head.
        const heads = refs.filter((r) => r.name === "parent" && (r.line === 4 || r.line === 5));
        assert.equal(heads.length, 0);
    });

    it("facts (bodyless clauses) emit no refs", () => {
        const refs = h().references("parent(alice, bob).");
        assert.deepEqual(refs, []);
    });

    it("passes the SPEC §16 conformance invariants", async () => {
        await assertHandlerConformance(h(), {
            source: SRC,
            decoyNames: ["frobnicate", "widget", "done", "family", "alice"],
            expectJoins: [
                { refName: "parent", container: "ancestor" },
                { refName: "ancestor", container: "ancestor" },
                { refName: "parent", container: "sibling" },
            ],
            expectRefs: [
                { name: "parent", kind: "call" },
                { name: "ancestor", kind: "call" },
                { name: "findall", kind: "call" },
            ],
        });
    });
});

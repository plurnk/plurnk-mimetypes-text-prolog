import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextProlog from "./TextProlog.ts";

const metadata = {
    mimetype: "text/x-prolog",
    glyph: "🧩",
    extensions: [".pl", ".pro", ".prolog"] as const,
};

describe("TextProlog — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextProlog(metadata);
        assert.equal(h.mimetype, "text/x-prolog");
        assert.equal(h.glyph, "🧩");
    });
});

describe("TextProlog — extract", () => {
    it("extracts facts as predicates", () => {
        const h = new TextProlog(metadata);
        const src = "father(tom, bob).";
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "father");
        assert.ok(f);
        assert.equal(f.kind, "function");
        assert.deepEqual(f.params, ["tom", "bob"]);
    });

    it("extracts rules (head :- body) using the head predicate", () => {
        const h = new TextProlog(metadata);
        const src = "parent(X, Y) :- father(X, Y).";
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "parent");
        assert.ok(p);
        assert.deepEqual(p.params, ["X", "Y"]);
        // Body predicates (father here) should NOT also be emitted — only
        // the head of each clause counts as a declaration site.
        const f = syms.filter((s) => s.name === "father");
        assert.equal(f.length, 0, "body predicates aren't emitted from rules");
    });

    it("extracts zero-arity (atom-head) predicates", () => {
        const h = new TextProlog(metadata);
        const src = "main :- write('hello'), nl.";
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "main");
        assert.ok(m);
        assert.deepEqual(m.params, []);
    });

    it("dedupes multi-clause predicates by (name, arity)", () => {
        const h = new TextProlog(metadata);
        const src = [
            "ancestor(X, Y) :- parent(X, Y).",
            "ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).",
        ].join("\n");
        const syms = h.extractRaw(src);
        const ancestors = syms.filter((s) => s.name === "ancestor");
        assert.equal(ancestors.length, 1);
    });

    it("treats same name with different arities as distinct predicates", () => {
        const h = new TextProlog(metadata);
        const src = [
            "edge(a, b).",
            "edge(a, b, weight).",
        ].join("\n");
        const syms = h.extractRaw(src);
        const edges = syms.filter((s) => s.name === "edge");
        assert.equal(edges.length, 2);
    });

    it("excludes directives like :- module(...)", () => {
        const h = new TextProlog(metadata);
        const src = [
            ":- module(family, [parent/2, ancestor/2]).",
            "parent(tom, bob).",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names, ["parent"]);
    });

    it("handles quoted atom predicates", () => {
        const h = new TextProlog(metadata);
        const src = "'has-a'(car, wheel).";
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "has-a");
        assert.ok(p);
    });

    it("returns empty array for empty input", () => {
        const h = new TextProlog(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source", () => {
        const h = new TextProlog(metadata);
        assert.doesNotThrow(() => h.extractRaw("(((broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ bogus"));
    });
});

describe("TextProlog — framework integration", () => {
    it("renders extracted hierarchy via format()", () => {
        const h = new TextProlog(metadata);
        const out = h.symbolsRaw("answer(42).");
        assert.ok(out.includes("function answer"));
    });

    it("inherits jsonpath query against the symbol outline", async () => {
        const h = new TextProlog(metadata);
        const src = "parent(tom, bob).";
        const p = await h.query(src, "jsonpath", "$.parent");
        assert.equal(p.length, 1);
    });
});

// Real-world smoke against a classic Prolog program — family relations
// + list operations.
describe("TextProlog — real-world smoke (family + lists)", () => {
    const SRC = [
        ":- module(family, [parent/2, ancestor/2, sibling/2]).",
        "",
        "% facts",
        "parent(alice, bob).",
        "parent(bob, charlie).",
        "parent(bob, dawn).",
        "parent(charlie, eve).",
        "",
        "% rules",
        "ancestor(X, Y) :- parent(X, Y).",
        "ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).",
        "",
        "sibling(X, Y) :- parent(P, X), parent(P, Y), X \\= Y.",
        "",
        "% list operations",
        "len([], 0).",
        "len([_|T], N) :- len(T, N1), N is N1 + 1.",
        "",
        "append([], L, L).",
        "append([H|T], L, [H|R]) :- append(T, L, R).",
    ].join("\n");

    it("surfaces all unique head predicates by name/arity", () => {
        const h = new TextProlog(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("parent"));
        assert.ok(names.has("ancestor"));
        assert.ok(names.has("sibling"));
        assert.ok(names.has("len"));
        assert.ok(names.has("append"));
    });

    it("dedupes multi-clause predicates", () => {
        const h = new TextProlog(metadata);
        const syms = h.extractRaw(SRC);
        const parents = syms.filter((s) => s.name === "parent");
        assert.equal(parents.length, 1);
        const len = syms.filter((s) => s.name === "len");
        assert.equal(len.length, 1);
        const append = syms.filter((s) => s.name === "append");
        assert.equal(append.length, 1);
    });
});

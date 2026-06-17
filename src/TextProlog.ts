import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { prologLexer } from "./generated/prologLexer.ts";
import { prologParser } from "./generated/prologParser.ts";
import { prologVisitor } from "./generated/prologVisitor.ts";

// text/x-prolog handler. ANTLR grammar from grammars-v4/prolog.
//
// Parser entry rule: p_text → (directive | clause)* EOF.
//   directive: ':-' term '.'    (e.g. :- module(foo, [bar/2]).)
//   clause:    term '.'         (fact or rule)
//
// In Prolog the unit of declaration is the PREDICATE — a name + arity.
// A clause head can be an atom (0-arg predicate) or `atom(args)` (compound
// term). Rules use the binary operator ':-' separating head from body —
// we surface the head's predicate only.
export default class TextProlog extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new prologLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new prologParser(tokens);
        parser.removeErrorListeners();
        return parser.p_text();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextPrologVisitor() as unknown as ExtractionVisitor;
    }
}

class TextPrologVisitor extends withExtractor(prologVisitor) {
    #emittedPredicates = new Set<string>();
    #bodyHead: string | null = null;

    visitClause = (ctx: any): null => {
        if (this.inBody) return null;
        const term = ctx.term?.();
        if (!term) return null;
        const pred = extractPredicate(clauseHead(term));
        if (pred) {
            const key = `${pred.name}/${pred.arity}`;
            if (!this.#emittedPredicates.has(key)) {
                this.#emittedPredicates.add(key);
                this.addSymbol("function", pred.name, ctx, pred.params);
            }
        }
        // A rule's BODY is a call graph: each body goal invokes a predicate.
        // Scope those `call` refs under the head predicate name so the edge's
        // container is the defining clause (SPEC §16 — container = enclosing
        // def, the @> join key). Refs resolve to head-predicate DEFINITIONS in
        // the same entry; built-ins (is, write, member, …) are honest dead rows.
        const body = clauseBody(term);
        if (body && pred) {
            this.#bodyHead = pred.name;
            // gateContainer pushes the head name as the ref container and visits
            // CHILDREN; wrap the body so it is visited as a child (a single-goal
            // body is a Compound/Atom term whose own children aren't goals).
            this.gateContainer(pred.name, { getChildCount: () => 1, getChild: () => body } as any);
            this.#bodyHead = null;
        }
        return null;
    };

    visitDirective = (_ctx: any): null => null;

    // Inside a gated body (gateContainer pushed the head predicate name), a
    // compound goal `name(args)` is a `call` to that predicate. We do NOT
    // recurse into its argument termlist: a goal riding in a meta-call argument
    // (findall(X, p(X), L)) is a term, not structurally a goal, and classifying
    // it needs meta-predicate knowledge we don't have. Precision over recall.
    visitCompound_term = (ctx: any): null => {
        if (this.#bodyHead === null) return null;
        const name = atomName(ctx.atom?.());
        if (name) this.addRef("call", name, ctx);
        return null;
    };

    // A bare atom in goal position (nl, true, !) is a 0-arity call. Skip the
    // cut `!` and control atoms — they're operators, not predicate calls.
    visitAtom_term = (ctx: any): null => {
        if (this.#bodyHead === null) return null;
        const name = atomName(ctx.atom?.());
        if (name && !CONTROL_ATOMS.has(name)) this.addRef("call", name, ctx);
        return null;
    };

    // Binary operators in body position are control combinators (`,` `;` `->`)
    // we descend through, or operator goals (X is E, X \= Y) we drop — a builtin
    // operator predicate is not a named-predicate call.
    visitBinary_operator = (ctx: any): null => {
        if (this.#bodyHead === null) return null;
        const op = ctx.operator_?.()?.getText?.();
        if (CONTROL_OPERATORS.has(op)) {
            for (const side of asArray(ctx.term?.())) this.visit(side as any);
        }
        return null;
    };
}

const CONTROL_OPERATORS = new Set([",", ";", "->", "*->", "|"]);
const CONTROL_ATOMS = new Set(["!", "true", "fail", "false"]);

function asArray(raw: unknown): unknown[] {
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

// For rules `head :- body`, head is the LHS of a binary_operator term
// where the operator is `:-`. For facts, the whole term is the head.
function clauseHead(term: unknown): unknown {
    const t = term as {
        constructor?: { name?: string };
        term?: () => Array<unknown> | unknown;
        operator_?: () => { getText?: () => string } | null;
    };
    if (t.constructor?.name === "Binary_operatorContext") {
        const op = t.operator_?.()?.getText?.();
        if (op === ":-" || op === "-->") {
            const sides = t.term?.();
            const arr = Array.isArray(sides) ? sides : sides ? [sides] : [];
            return arr[0] ?? null;
        }
    }
    return term;
}

// For rules `head :- body` / DCG `head --> body`, the body is the RHS of the
// binary operator. Facts have no body.
function clauseBody(term: unknown): unknown {
    const t = term as {
        constructor?: { name?: string };
        term?: () => Array<unknown> | unknown;
        operator_?: () => { getText?: () => string } | null;
    };
    if (t.constructor?.name === "Binary_operatorContext") {
        const op = t.operator_?.()?.getText?.();
        if (op === ":-" || op === "-->") {
            const arr = asArray(t.term?.());
            return arr[1] ?? null;
        }
    }
    return null;
}

function extractPredicate(head: unknown): { name: string; arity: number; params: string[] } | null {
    const t = head as {
        constructor?: { name?: string };
        atom?: () => { getText?: () => string } | null;
        termlist?: () => unknown;
    };
    // Compound term: atom '(' termlist ')'
    if (t.constructor?.name === "Compound_termContext") {
        const name = atomName(t.atom?.());
        if (!name) return null;
        const params = termlistTexts(t.termlist?.());
        return { name, arity: params.length, params };
    }
    // Atom term (zero-arg predicate)
    if (t.constructor?.name === "Atom_termContext") {
        const inner = (head as { atom?: () => unknown }).atom?.();
        const name = atomName(inner);
        if (!name) return null;
        return { name, arity: 0, params: [] };
    }
    return null;
}

function atomName(atom: unknown): string | null {
    if (!atom) return null;
    const raw = (atom as { getText?: () => string }).getText?.();
    if (!raw) return null;
    // Quoted atoms like 'my predicate' — unquote.
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
        return raw.slice(1, -1).replace(/''/g, "'");
    }
    return raw;
}

// termlist: term (',' term)*  in the grammar — but in practice ANTLR parses
// `X, Y` as a SINGLE term of shape Binary_operatorContext with operator `,`.
// Walk the binary tree splitting on commas to recover the actual argument
// list. This pattern recurses: `f(A, B, C, D)` parses as left-leaning
// `,(,(,(A,B),C),D)` which we flatten via DFS.
function termlistTexts(termlist: unknown): string[] {
    if (!termlist) return [];
    const node = termlist as { term?: () => Array<unknown> | unknown };
    const raw = node.term?.();
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: string[] = [];
    for (const t of arr) splitOnComma(t, out);
    return out;
}

function splitOnComma(term: unknown, out: string[]): void {
    const t = term as {
        constructor?: { name?: string };
        term?: () => Array<unknown> | unknown;
        operator_?: () => { getText?: () => string } | null;
        getText?: () => string;
    };
    if (t.constructor?.name === "Binary_operatorContext"
        && t.operator_?.()?.getText?.() === ",") {
        const sides = t.term?.();
        const arr = Array.isArray(sides) ? sides : sides ? [sides] : [];
        for (const s of arr) splitOnComma(s, out);
        return;
    }
    const txt = t.getText?.();
    if (txt) out.push(txt);
}

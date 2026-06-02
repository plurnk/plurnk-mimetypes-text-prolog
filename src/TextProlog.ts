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

    visitClause = (ctx: any): null => {
        if (this.inBody) return null;
        const term = ctx.term?.();
        if (!term) return null;
        const head = clauseHead(term);
        if (!head) return null;
        const pred = extractPredicate(head);
        if (!pred) return null;
        const key = `${pred.name}/${pred.arity}`;
        if (this.#emittedPredicates.has(key)) return null;
        this.#emittedPredicates.add(key);
        this.addSymbol("function", pred.name, ctx, pred.params);
        return null;
    };

    visitDirective = (_ctx: any): null => null;
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

import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextProlog.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({"mimetype":"text/x-prolog","glyph":"🧩","extensions":[".pl",".pro",".prolog"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "foo(a).\nbar(X):-foo(X).\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});

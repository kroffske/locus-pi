import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../extensions/workflows/tool/workflow-source-shape.js";
const errors = (source: string) =>
  orchestrationOnlyWorkflowSourceShapeDiagnostics(source).filter((item) => item.severity === "error");
const wrap = (body: string, declarations = "") =>
  `export const meta = { name: "test", profile: "standard" };\n${declarations}\nexport default async function run(dsl, input) { ${body} }`;
const bounded = (body: string) =>
  wrap(
    `let carry = ""; for (let round = 1; round <= 3; round += 1) { const answer = await dsl.agent(input, { label: "work" }); ${body} } return carry;`,
  );
describe("standard bounded carry and author-owned records; requires native ast-grep", () => {
  it.each(["fixed", "refinement", "decomposition"])(
    "checks the actual %s example source, not a rewritten fixture",
    (name: string) => {
      const source = readFileSync(
        path.resolve(`extensions/workflows/references/examples/${name}.workflow.mjs`),
        "utf8",
      );
      expect(errors(source)).toEqual([]);
    },
  );
  it("allows whole-answer carry and exact runtime control, including ++ bounds", () => {
    expect(errors(bounded("carry = answer;"))).toEqual([]);
    expect(
      errors(
        wrap(
          'let previous = "start"; for (let i = 0; i < 2; i++) { const decision = await dsl.agent(input, { label: "route", choice: ["complete", ' +
            '"continue"] }); if (previous === "complete") return decision; previous = decision; } return previous;',
        ),
      ),
    ).toEqual([]);
  });
  it("allows named author-owned record properties and flat destructuring", () => {
    const declarations =
      'const FIELDS = [{ key: "id", question: "Exact ID?" }, { key: "schedule", question: "Schedule?" }];';
    expect(
      errors(
        wrap(
          'return dsl.parallel(FIELDS.map((field) => () => dsl.agent(field.question, { label: "field", title: field.key })), { keys: ' +
            "FIELDS.map((entry) => entry.key), concurrency: 2 });",
          declarations,
        ),
      ),
    ).toEqual([]);
    expect(
      errors(
        wrap(
          'return dsl.parallel(FIELDS.map(({ key, question }) => () => dsl.agent(question, { label: "field", title: key })));',
          declarations,
        ),
      ),
    ).toEqual([]);
  });
  it.each([
    "carry = answer.trim();",
    "carry = answer; const alias = carry; if (alias.length > 0) return alias;",
    'carry = answer; if (carry === "complete") return carry;',
    "carry = { text: answer };",
    "carry = answer; round = 1;",
    "carry = answer; await dsl.parallel([async () => { carry = answer; return answer; }]);",
  ])("rejects transforms, taint laundering and shared mutation: %s", (body: string) => {
    expect(errors(bounded(body)).length).toBeGreaterThan(0);
  });
  it.each([
    'let carry = ""; while (true) { carry = await dsl.agent(input, { label: "work" }); }',
    'let carry = ""; for (let i = 0; i < input; i++) { carry = await dsl.agent(input, { label: "work" }); }',
    'let carry = ""; for (let i = 0; i < 3; i--) { carry = await dsl.agent(input, { label: "work" }); }',
    'let carry = ""; for (let i = 0; i < 3; i++) { carry = await dsl.agent(input, { label: "work" }); carry = "forged"; }',
  ])("does not admit carry without a proven finite loop: %s", (body: string) => {
    expect(errors(wrap(body)).length).toBeGreaterThan(0);
  });
  it("does not turn captured model output into an author-owned mapped object", () => {
    const body =
      'const text = await dsl.agent(input, { label: "read" }); const records = ["id"].map((key) => ({ key, value: text })); return ' +
      'dsl.parallel(records.map((record) => () => dsl.agent(record.value, { label: "write" })));';
    expect(errors(wrap(body)).length).toBeGreaterThan(0);
  });
  it("keeps discovered handoffs opaque despite the new author-record syntax", () => {
    const body =
      'const values = await dsl.agent(input, { label: "discover", handoffs: { maxItems: 3 } }); return dsl.parallel(values.map(({ key }) => () => dsl.agent(key, { label: "work" })));';
    expect(errors(wrap(body)).length).toBeGreaterThan(0);
  });
});

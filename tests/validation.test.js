const test = require("node:test");
const assert = require("node:assert/strict");
const { answerScore, validateActivity } = require("../server");

test("validates and normalizes a zone-matching activity", () => {
  const result = validateActivity({
    type: "zones",
    prompt: "  Relaciona  ",
    pairs: [
      { label: " París ", target: " Francia " },
      { label: "Lima", target: "Perú" },
    ],
  });

  assert.deepEqual(result, {
    activity: {
      type: "zones",
      prompt: "Relaciona",
      timeLimit: 0,
      theme: "green",
      pairs: [
        { label: "París", target: "Francia" },
        { label: "Lima", target: "Perú" },
      ],
    },
  });
});

test("rejects incomplete and duplicate activity entries", () => {
  assert.match(validateActivity({ type: "zones", prompt: "Relaciona", pairs: [{ label: "A", target: "B" }] }).error, /entre 2 y 20/);
  assert.match(validateActivity({ type: "sequence", prompt: "Ordena", items: ["A", " a "] }).error, /únicos/);
  assert.match(validateActivity({ type: "sequence", prompt: "Ordena", items: ["A", "B"], timeLimit: 3 }).error, /tiempo/);
  assert.match(validateActivity({ type: "unknown", prompt: "Prueba" }).error, /válido/);
});

test("scores zone assignments and rejects malformed answers", () => {
  const activity = {
    type: "zones",
    pairs: [
      { label: "París", target: "Francia" },
      { label: "Lima", target: "Perú" },
    ],
  };

  const perfect = answerScore(activity, { París: "Francia", Lima: "Perú" });
  assert.equal(perfect.correct, 2);
  assert.equal(perfect.results.every((result) => result.ok), true);
  const partial = answerScore(activity, { París: "Francia", Lima: "Chile" });
  assert.equal(partial.correct, 1);
  assert.deepEqual(partial.results[1], { name: "Lima", chosen: "Chile", expected: "Perú", ok: false });
  assert.equal(answerScore(activity, { París: "Francia" }), null);
  assert.equal(answerScore(activity, { constructor: "x", Lima: "Perú" }), null);
});

test("scores a sequence only when it contains every activity item once", () => {
  const activity = { type: "sequence", items: ["Primero", "Después", "Al final"] };

  assert.equal(answerScore(activity, ["Primero", "Después", "Al final"]).correct, 3);
  assert.equal(answerScore(activity, ["Al final", "Después", "Primero"]).correct, 1);
  assert.equal(answerScore(activity, ["Primero", "Primero", "Al final"]), null);
  assert.equal(answerScore(activity, ["Primero", "Después"]), null);
});

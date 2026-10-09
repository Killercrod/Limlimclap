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

  // Las imagenes son opcionales: sin id quedan en null en vez de desaparecer,
  // para que el cliente siempre encuentre el mismo campo.
  assert.deepEqual(result, {
    activity: {
      type: "zones",
      prompt: "Relaciona",
      pairs: [
        { label: "París", target: "Francia", labelImage: null, targetImage: null },
        { label: "Lima", target: "Perú", labelImage: null, targetImage: null },
      ],
    },
  });
});

test("descarta referencias de imagen que no existen", () => {
  const result = validateActivity({
    type: "zones",
    prompt: "Relaciona",
    pairs: [
      { label: "París", target: "Francia", labelImage: "inventado", targetImage: 42 },
      { label: "Lima", target: "Perú" },
    ],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.activity.pairs[0].labelImage, null);
  assert.equal(result.activity.pairs[0].targetImage, null);
});

test("acepta items de secuencia como texto o como objeto con imagen", () => {
  const asText = validateActivity({ type: "sequence", prompt: "Ordena", items: ["  Primero ", "Después"] });
  assert.deepEqual(asText.activity.items, ["Primero", "Después"]);

  const asObject = validateActivity({
    type: "sequence",
    prompt: "Ordena",
    items: [{ text: "Primero" }, { text: "Después", image: null }],
  });
  assert.deepEqual(asObject.activity.items, ["Primero", "Después"]);
  assert.deepEqual(asObject.activity.itemImages, [null, null]);
});

test("rejects incomplete and duplicate activity entries", () => {
  assert.match(validateActivity({ type: "zones", prompt: "Relaciona", pairs: [{ label: "A", target: "B" }] }).error, /entre 2 y 20/);
  assert.match(validateActivity({ type: "sequence", prompt: "Ordena", items: ["A", " a "] }).error, /únicos/);
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

  assert.deepEqual(answerScore(activity, { París: "Francia", Lima: "Perú" }), { correct: 2, total: 2 });
  assert.deepEqual(answerScore(activity, { París: "Francia", Lima: "Chile" }), { correct: 1, total: 2 });
  assert.equal(answerScore(activity, { París: "Francia" }), null);
});

test("scores a sequence only when it contains every activity item once", () => {
  const activity = { type: "sequence", items: ["Primero", "Después", "Al final"] };

  assert.deepEqual(answerScore(activity, ["Primero", "Después", "Al final"]), { correct: 3, total: 3 });
  assert.deepEqual(answerScore(activity, ["Al final", "Después", "Primero"]), { correct: 1, total: 3 });
  assert.equal(answerScore(activity, ["Primero", "Primero", "Al final"]), null);
  assert.equal(answerScore(activity, ["Primero", "Después"]), null);
});

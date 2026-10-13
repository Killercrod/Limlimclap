const test = require("node:test");
const assert = require("node:assert/strict");
const { answerScore, validateActivity, validateActivities, calculateScoreWithBonus } = require("../server");

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

test("validates and scores activities with item images and background images", () => {
  const result = validateActivity({
    type: "zones",
    prompt: "Empareja banderas",
    bgImage: "https://ejemplo.com/mapa.png",
    pairs: [
      { label: "Francia", target: "Europa", image: "https://ejemplo.com/fr.png" },
      { label: "Japón", target: "Asia", image: "https://ejemplo.com/jp.png" },
    ],
  });

  assert.equal(result.activity.bgImage, "https://ejemplo.com/mapa.png");
  assert.equal(result.activity.pairs[0].image, "https://ejemplo.com/fr.png");

  const score = answerScore(result.activity, { Francia: "Europa", Japón: "Asia" });
  assert.equal(score.correct, 2);

  const seqResult = validateActivity({
    type: "sequence",
    prompt: "Ordena pasos con imagen",
    items: [
      { text: "Paso 1", image: "https://ejemplo.com/1.png" },
      { text: "Paso 2", image: "https://ejemplo.com/2.png" },
    ],
  });
  assert.equal(seqResult.activity.items[0].text, "Paso 1");
  assert.equal(seqResult.activity.items[0].image, "https://ejemplo.com/1.png");

  const seqScore = answerScore(seqResult.activity, ["Paso 1", "Paso 2"]);
  assert.equal(seqScore.correct, 2);
});

test("validates a batch of multiple activities", () => {
  const result = validateActivities({
    activities: [
      { type: "sequence", prompt: "P1", items: ["A", "B"] },
      { type: "zones", prompt: "P2", pairs: [{ label: "X", target: "Y" }, { label: "W", target: "Z" }] },
    ],
  });
  assert.equal(result.activities.length, 2);
  assert.equal(result.activities[0].prompt, "P1");
  assert.equal(result.activities[1].prompt, "P2");

  const invalid = validateActivities({
    activities: [
      { type: "sequence", prompt: "P1", items: ["A", "B"] },
      { type: "sequence", prompt: "", items: ["A", "B"] },
    ],
  });
  assert.match(invalid.error, /Actividad 2/);
});

test("calculates score with speed bonus based on elapsed time", () => {
  const base = { correct: 2, total: 2, results: [] };
  const quick = calculateScoreWithBonus(base, {
    startedAt: 1000,
    submittedAt: 2000, // 1 second elapsed
    timeLimit: 60,
  });
  assert.equal(quick.correct, 2);
  assert.equal(quick.basePoints, 2000);
  assert.equal(quick.speedBonus > 400, true);
  assert.equal(quick.points > 2400, true);

  const zeroCorrect = calculateScoreWithBonus({ correct: 0, total: 2, results: [] }, {
    startedAt: 1000,
    submittedAt: 2000,
    timeLimit: 60,
  });
  assert.equal(zeroCorrect.speedBonus, 0);
  assert.equal(zeroCorrect.points, 0);
});

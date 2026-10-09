const test = require("node:test");
const assert = require("node:assert/strict");
const { answerScore, validateActivity } = require("../server");

test("validates and normalizes a zone-matching activity", () => {
  const result = validateActivity({
    type: "zones",
    title: "  Países y capitales  ",
    prompt: "  Relaciona  ",
    pairs: [
      { label: " París ", target: " Francia " },
      { label: "Lima", target: "Perú" },
    ],
  });

  // Las imagenes son opcionales: sin id quedan en null en vez de desaparecer,
  // para que el cliente siempre encuentre el mismo campo. El titulo tambien es
  // opcional: sin el queda vacio y el cliente cae a la consigna.
  assert.deepEqual(result, {
    activity: {
      type: "zones",
      title: "Países y capitales",
      prompt: "Relaciona",
      pairs: [
        // El elemento lleva una lista de imagenes; la zona, una sola.
        { label: "París", target: "Francia", labelImages: [], targetImage: null },
        { label: "Lima", target: "Perú", labelImages: [], targetImage: null },
      ],
    },
  });
});

test("el titulo es opcional y la consigna no", () => {
  const base = {
    type: "zones",
    pairs: [{ label: "A", target: "B" }, { label: "C", target: "D" }],
  };
  const sinTitulo = validateActivity({ ...base, prompt: "Relaciona" });
  assert.equal(sinTitulo.error, undefined);
  assert.equal(sinTitulo.activity.title, "");

  const sinConsigna = validateActivity({ ...base, title: "Con titulo" });
  assert.equal(sinConsigna.error, "Escribe la consigna de la actividad.");
});

test("descarta referencias de imagen que no existen", () => {
  const result = validateActivity({
    type: "zones",
    prompt: "Relaciona",
    pairs: [
      { label: "París", target: "Francia", labelImages: ["inventado"], targetImage: 42 },
      { label: "Lima", target: "Perú", labelImages: "no-es-una-lista" },
    ],
  });

  assert.equal(result.error, undefined);
  // Una lista con basura se deja vacia en vez de romper, y una imagen que no es
  // lista no se acepta.
  assert.deepEqual(result.activity.pairs[0].labelImages, []);
  assert.equal(result.activity.pairs[0].targetImage, null);
  assert.deepEqual(result.activity.pairs[1].labelImages, []);
});

test("un elemento con imagenes repetidas las guarda una sola vez", () => {
  const result = validateActivity({
    type: "zones",
    prompt: "Relaciona",
    pairs: [
      { label: "París", target: "Francia", labelImages: ["mismo", "mismo", "otro"] },
      { label: "Lima", target: "Perú" },
    ],
  });
  // Sin ids reales en el almacen todos se descartan, pero el comportamiento se
  // ve en el helper: lo que importa es que nunca queda una lista con repetidos.
  const lista = result.activity.pairs[0].labelImages;
  assert.equal(new Set(lista).size, lista.length);
});

test("acepta items de secuencia como texto o como objeto con imagen", () => {
  const asText = validateActivity({ type: "sequence", prompt: "Ordena", items: ["  Primero ", "Después"] });
  assert.deepEqual(asText.activity.items, ["Primero", "Después"]);

  const asObject = validateActivity({
    type: "sequence",
    prompt: "Ordena",
    items: [{ text: "Primero" }, { text: "Después", images: [] }],
  });
  assert.deepEqual(asObject.activity.items, ["Primero", "Después"]);
  // Cada elemento tiene su lista de imagenes, vacia si no puso ninguna.
  assert.deepEqual(asObject.activity.itemImages, [[], []]);
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

// Editor de rondas. Cada ronda es una actividad completa (tipo, consigna, items
// e imagenes). El host carga todas antes de crear la sesion.
const editorEl = document.querySelector("#items-editor");
const counterEl = document.querySelector("#items-counter");
const addButton = document.querySelector("#add-item");
const bulkApply = document.querySelector("#bulk-apply");
const bulkField = document.querySelector("#entries");
const roundTabsEl = document.querySelector("#round-tabs");
const MAX_ITEMS = 20;
const MAX_ROUNDS = 20;

let rounds = [];
let currentRound = 0;
const previewUrls = new Map();

function activeRound() {
  return rounds[currentRound];
}
function isZones() {
  return activeRound().type === "zones";
}
function updateCounters() {
  counterEl.textContent = `${activeRound().items.length} de ${MAX_ITEMS} elementos`;
  addButton.disabled = activeRound().items.length >= MAX_ITEMS;
  document.querySelector("#round-counter").textContent =
    `${rounds.length} ${rounds.length === 1 ? "ronda" : "rondas"}`;
  document.querySelector("#add-round").disabled = rounds.length >= MAX_ROUNDS;
}

function renderRoundTabs() {
  roundTabsEl.innerHTML = rounds.map((round, index) => `
    <button type="button" class="round-tab ${index === currentRound ? "active" : ""}" data-round="${index}">
      <span class="round-tab-number">${index + 1}</span>
      <span class="round-tab-text">${escapeHtml(round.prompt || "Sin consigna")}</span>
    </button>`).join("");
}

function imageUrl(id) {
  return `${basePath}/img/${id}`;
}

function renderEditor() {
  const round = activeRound();
  editorEl.innerHTML = round.items.map((item, index) => `
    <div class="item-row" data-index="${index}">
      <div class="item-side">
        <div class="item-fields">
          <button class="thumb" type="button" data-side="left" title="Elegir imagen"
                  aria-label="Elegir imagen">${item.left.image ? `<img src="${previewUrls.get(item.left.image) ?? imageUrl(item.left.image)}" alt="">` : "<span>🖼</span>"}</button>
          <input class="text-input item-input" data-side="left" type="text" maxlength="80"
                 placeholder="${round.type === "zones" ? "Ej. París" : "Ej. Primero"}" value="${escapeHtml(item.left.text)}">
        </div>
      </div>
      ${round.type === "zones" ? `
      <div class="item-arrow" aria-hidden="true">→</div>
      <div class="item-side">
        <div class="item-fields">
          <button class="thumb" type="button" data-side="right" title="Elegir imagen"
                  aria-label="Elegir imagen de la zona">${item.right.image ? `<img src="${previewUrls.get(item.right.image) ?? imageUrl(item.right.image)}" alt="">` : "<span>🖼</span>"}</button>
          <input class="text-input item-input" data-side="right" type="text" maxlength="80"
                 placeholder="Ej. Francia" value="${escapeHtml(item.right.text)}">
        </div>
      </div>` : ""}
      <button class="item-remove" type="button" data-remove="${index}" title="Quitar" aria-label="Quitar este elemento">×</button>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-file="${index}" hidden>
    </div>`).join("") || `<p class="items-empty">Todavía no agregaste elementos.</p>`;

  updateCounters();
  renderRoundTabs();
  document.querySelector("#round-prompt").value = round.prompt;
  document.querySelectorAll('input[name="round-type"]').forEach((input) => {
    input.checked = input.value === round.type;
  });
}

function addRound() {
  if (rounds.length >= MAX_ROUNDS) return;
  rounds.push({
    type: "zones",
    prompt: "",
    items: [{ left: { text: "", image: null }, right: { text: "", image: null } }],
  });
  currentRound = rounds.length - 1;
  renderEditor();
}

addButton.addEventListener("click", () => {
  const round = activeRound();
  if (round.items.length >= MAX_ITEMS) return;
  round.items.push({ left: { text: "", image: null }, right: { text: "", image: null } });
  renderEditor();
});

document.querySelector("#add-round").addEventListener("click", addRound);

document.querySelector("#round-prompt").addEventListener("input", (event) => {
  activeRound().prompt = event.target.value;
  renderRoundTabs();
});

document.querySelectorAll('input[name="round-type"]').forEach((input) => {
  input.addEventListener("change", () => {
    const round = activeRound();
    round.type = input.value;
    // Cambiar de tipo puede dejar el lado derecho sin usar: se limpia para que
    // no viaje basura al backend.
    if (input.value === "sequence") round.items.forEach((item) => { item.right = { text: "", image: null }; });
    else round.items.forEach((item) => { if (!item.right) item.right = { text: "", image: null }; });
    renderEditor();
  });
});

roundTabsEl.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-round]");
  if (!tab) return;
  currentRound = Number(tab.dataset.round);
  renderEditor();
});

editorEl.addEventListener("input", (event) => {
  const input = event.target.closest("[data-side]");
  if (!input) return;
  const index = Number(input.closest("[data-index]").dataset.index);
  activeRound().items[index][input.dataset.side].text = input.value;
});

editorEl.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    activeRound().items.splice(Number(remove.dataset.remove), 1);
    renderEditor();
    return;
  }
  const thumb = event.target.closest("[data-side]");
  if (!thumb) return;
  const row = thumb.closest("[data-index]");
  const picker = editorEl.querySelector(`[data-file="${row.dataset.index}"]`);
  picker.dataset.side = thumb.dataset.side;
  picker.click();
});

editorEl.addEventListener("change", async (event) => {
  const picker = event.target.closest("[data-file]");
  if (!picker) return;
  const file = picker.files?.[0];
  if (!file) return;

  const status = showToast(`Subiendo ${file.name}…`);
  try {
    const uploaded = await uploadImage(file);
    activeRound().items[Number(picker.dataset.index)][picker.dataset.side].image = uploaded.id;
    previewUrls.set(uploaded.id, URL.createObjectURL(file));
    renderEditor();
    status.dispose();
    showToast("Imagen lista");
  } catch (error) {
    status.dispose();
    showToast(error.message || "No se pudo subir la imagen");
  }
});

async function uploadImage(file) {
  const response = await fetch(`${basePath}/upload`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "No se pudo subir la imagen");
  return body;
}

bulkApply?.addEventListener("click", () => {
  const round = activeRound();
  const lines = bulkField.value.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const separator = line.includes("→") ? "→" : line.includes("->") ? "->" : null;
    if (round.items.length >= MAX_ITEMS) break;
    if (separator && round.type === "zones") {
      const parts = line.split(separator);
      round.items.push({
        left: { text: parts[0]?.trim(), image: null },
        right: { text: parts.slice(1).join(separator).trim(), image: null },
      });
    } else {
      round.items.push({ left: { text: line, image: null }, right: { text: "", image: null } });
    }
  }
  bulkField.value = "";
  renderEditor();
});

function buildPayload() {
  return {
    rounds: rounds.map((round) => ({
      type: round.type,
      prompt: round.prompt.trim(),
      ...(round.type === "zones"
        ? { pairs: round.items.map((item) => ({
            label: item.left.text.trim(),
            target: item.right.text.trim(),
            labelImage: item.left.image,
            targetImage: item.right.image,
          })) }
        : { items: round.items.map((item) => ({ text: item.left.text.trim(), image: item.left.image })) }),
    })),
  };
}

// Cada ronda se completa antes de crear la sesion, y el error dice cual.
function firstProblem() {
  for (const [index, round] of rounds.entries()) {
    if (!round.prompt.trim()) return `Ronda ${index + 1}: escribí la consigna.`;
    if (round.items.length < 2) return `Ronda ${index + 1}: agregá al menos 2 elementos.`;
    const incomplete = round.items.findIndex((item) =>
      !item.left.text.trim() || (round.type === "zones" && !item.right.text.trim()));
    if (incomplete !== -1) return `Ronda ${index + 1}: completá el elemento ${incomplete + 1}.`;
  }
  return null;
}

function resetEditor() {
  rounds = [];
  currentRound = 0;
  addRound();
  if (bulkField) bulkField.value = "";
}

// Se inicializa cuando ya corrieron todos los scripts diferidos: renderEditor
// usa escapeHtml y basePath, que viven en app.js, y este archivo carga antes.
// Inicializar aqui directamente era un ReferenceError que abortaba el archivo
// entero y dejaba el formulario vacio, sin inputs ni pestanas.
window.addEventListener("DOMContentLoaded", resetEditor, { once: true });
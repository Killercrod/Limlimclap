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
// El borrador vive en el navegador: si se cierra la pestana a media
// configuracion, al volver sigue todo. Se guarda solo el texto y el id de cada
// imagen, nunca los bytes, asi que el peso es de unos pocos KB.
const DRAFT_KEY = "limlimclap:borrador";

let rounds = [];
let currentRound = 0;
const previewUrls = new Map();

// El borrador se guarda al cambiar algo, no en cada tecla: se serializa y se
// escribe en cada input, que con 20 rondas es barato pero innecesario.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
  try {
    if (!rounds.length) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ rounds, currentRound }));
  } catch {
    // Cuota llena o almacenamiento bloqueado (modo privado): se sigue igual,
    // solo que el borrador no se guarda.
  }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.rounds) || !data.rounds.length) return null;
    // El borrador sale de localStorage, que se puede editar a mano o quedar de
    // una version anterior del editor. Se completa lo que falte en vez de
    // confiar en la forma: un campo raro no debe impedir abrir el formulario.
    const rounds = data.rounds.map((round) => ({
      type: round?.type === "sequence" ? "sequence" : "zones",
      prompt: typeof round?.prompt === "string" ? round.prompt : "",
      items: (Array.isArray(round?.items) ? round.items : []).map((item) => ({
        left: { text: String(item?.left?.text ?? ""), image: item?.left?.image ?? null },
        right: { text: String(item?.right?.text ?? ""), image: item?.right?.image ?? null },
      })),
    }));
    return { rounds, currentRound: Number(data.currentRound) || 0 };
  } catch {
    return null;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // sin almacenamiento no hay borrador que borrar
  }
}

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

// imageUrl vive en app.js, junto a basePath: el editor depende de app.js, no al
// reves. Antes estaba aca y app.js la usaba para las imagenes de la sala en
// vivo, o sea que el archivo que dibuja la partida dependia de que este cargara.

// Un unico input de archivo para todo el editor, y no uno por fila. Se dispara
// desde el boton de la miniatura.
//
// Antes cada fila traia su propio <input type="file" hidden>. El atributo hidden
// no alcanza: el navegador lo igualaba a pintar y se veía la ruta cruda al lado
// del campo de texto ("C:\fakepath\pregunta 1.jpeg"), que ademas ocupaba lugar en
// la fila y por ahi no se podia escribir. No se usa display:none porque con el
// input en display:none algunos navegadores no abren el dialogo: se lo saca de
// la pantalla en vez de esconderlo.
const picker = document.createElement("input");
picker.type = "file";
picker.className = "file-picker";
picker.accept = "image/png,image/jpeg,image/gif,image/webp";
document.body.appendChild(picker);
let pickerTarget = null;

function renderEditor() {
  const round = activeRound();
  editorEl.innerHTML = round.items.length ? round.items.map((item, index) => `
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
    </div>`).join("")
    : `<p class="items-empty">Todavía no agregaste elementos.</p>`;

  updateCounters();
  renderRoundTabs();
  scheduleSave();
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
  scheduleSave();
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
  scheduleSave();
});

editorEl.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    activeRound().items.splice(Number(remove.dataset.remove), 1);
    renderEditor();
    return;
  }
  // Solo la miniatura abre el selector de archivos. Los campos de texto tambien
  // tienen data-side, asi que con closest("[data-side]") el clic para escribir
  // caia aqui, abria el dialogo de archivos y el campo perdia el foco al
  // instante: no se podia escribir al lado de la imagen.
  const thumb = event.target.closest("button.thumb[data-side]");
  if (!thumb) return;
  const row = thumb.closest("[data-index]");
  if (!row) return;
  // Se guarda a que elemento y de que lado va la imagen, y se dispara el input
  // comun. Antes habia un input por fila y se leia su indice por atributo.
  pickerTarget = { index: Number(row.dataset.index), side: thumb.dataset.side };
  picker.value = "";
  picker.click();
});

picker.addEventListener("change", async () => {
  const file = picker.files?.[0];
  const target = pickerTarget;
  pickerTarget = null;
  if (!file || !target) return;

  const status = showToast("Subiendo imagen…");
  try {
    const uploaded = await uploadImage(file);
    const round = activeRound();
    if (!round.items[target.index] || !round.items[target.index][target.side]) {
      throw new Error("No se encontró dónde poner la imagen. Volvé a abrir la ronda.");
    }
    round.items[target.index][target.side].image = uploaded.id;
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

// Descartar el borrador guardado y volver a una ronda vacia.
document.querySelector("#discard-draft")?.addEventListener("click", () => {
  clearDraft();
  resetEditor();
  document.querySelector("#create-error").textContent = "";
  showToast("Borrador borrado");
});

// Cuando la sesion ya existe, el borrador cumplio: dejarlo guardado volveria a
// ofrecer crearla otra vez al volver al formulario.
function discardDraftOnCreate() {
  clearDraft();
}

// Al volver, las imagenes del borrador se comprueban una por una: viven en
// memoria del servidor, asi que un reinicio las borro y el id guardado ya no
// sirve. Las que fallen se quitan y se avisa, en vez de dejar un cuadrito roto
// o un 404 silencioso.
async function checkImages(allRounds) {
  const ids = new Set();
  for (const round of allRounds) {
    for (const item of round.items) {
      for (const side of ["left", "right"]) {
        if (item[side]?.image) ids.add(item[side].image);
      }
    }
  }
  if (!ids.size) return 0;

  const alive = new Map();
  await Promise.all([...ids].map(async (id) => {
    try {
      const response = await fetch(`${basePath}/img/${id}`, { method: "HEAD" });
      alive.set(id, response.ok);
    } catch {
      alive.set(id, false);
    }
  }));

  let lost = 0;
  for (const round of allRounds) {
    for (const item of round.items) {
      for (const side of ["left", "right"]) {
        const image = item[side]?.image;
        if (!image) continue;
        if (alive.get(image)) continue;
        item[side].image = null;
        lost += 1;
      }
    }
  }
  return lost;
}

async function init() {
  const draft = readDraft();
  if (!draft) {
    addRound();
    return;
  }
  rounds = draft.rounds;
  currentRound = Math.min(Math.max(0, draft.currentRound || 0), rounds.length - 1);

  const lost = await checkImages(rounds);
  renderEditor();
  if (lost) {
    showToast(`${lost} imagen(es) se perdieron en un reinicio del servidor. Vuelvelas a subir.`);
  } else {
    showToast(`Borrador restaurado: ${rounds.length} ronda(s).`);
  }
}

// Se inicializa cuando ya corrieron todos los scripts diferidos: renderEditor
// usa escapeHtml y basePath, que viven en app.js, y este archivo carga antes.
// Inicializar aqui directamente era un ReferenceError que abortaba el archivo
// entero y dejaba el formulario vacio, sin inputs ni pestanas.
window.addEventListener("DOMContentLoaded", init, { once: true });
// Editor de items con imagen opcional. Reemplaza tener que escribir
// "Elemento -> Zona": se agrega cada pareja en su propia fila y las imagenes se
// suben al elegir el archivo.
const editorEl = document.querySelector("#items-editor");
const counterEl = document.querySelector("#items-counter");
const addButton = document.querySelector("#add-item");
const bulkApply = document.querySelector("#bulk-apply");
const bulkField = document.querySelector("#entries");
const MAX_ITEMS = 20;

let items = [];

// Una imagen subida por esta sesion se guarda como blob URL para la vista
// previa inmediata, mientras el servidor guarda la copia con su id.
const previewUrls = new Map();

function isZones() {
  return getSelectedType() === "zones";
}

function updateCounter() {
  counterEl.textContent = `${items.length} de ${MAX_ITEMS}`;
  addButton.disabled = items.length >= MAX_ITEMS;
}

function renderEditor() {
  const zones = isZones();
  editorEl.innerHTML = items.map((item, index) => `
    <div class="item-row" data-index="${index}">
      <div class="item-side">
        <span class="item-side-label">${zones ? "Elemento" : "Elemento"}</span>
        <div class="item-fields">
          <button class="thumb" type="button" data-side="left" title="Elegir imagen"
                  aria-label="Elegir imagen de ${escapeHtml(item.left.text || "elemento")}">
            ${item.left.image ? `<img src="${previewUrls.get(item.left.image) ?? imageUrl(item.left.image)}" alt="">` : "<span>🖼</span>"}
          </button>
          <input class="text-input item-input" data-side="left" type="text" maxlength="80"
                 placeholder="${zones ? "Ej. París" : "Ej. Primero"}" value="${escapeHtml(item.left.text)}">
        </div>
      </div>
      ${zones ? `
      <div class="item-arrow" aria-hidden="true">→</div>
      <div class="item-side">
        <span class="item-side-label">Zona</span>
        <div class="item-fields">
          <button class="thumb" type="button" data-side="right" title="Elegir imagen"
                  aria-label="Elegir imagen de la zona">
            ${item.right.image ? `<img src="${previewUrls.get(item.right.image) ?? imageUrl(item.right.image)}" alt="">` : "<span>🖼</span>"}
          </button>
          <input class="text-input item-input" data-side="right" type="text" maxlength="80"
                 placeholder="Ej. Francia" value="${escapeHtml(item.right.text)}">
        </div>
      </div>` : ""}
      <button class="item-remove" type="button" data-remove="${index}" title="Quitar" aria-label="Quitar este elemento">×</button>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-file="${index}" hidden>
    </div>`).join("");

  if (!items.length) {
    editorEl.innerHTML = `<p class="items-empty">Todavía no agregaste elementos.</p>`;
  }
  updateCounter();
}

function imageUrl(id) {
  return `${basePath}/img/${id}`;
}

function addItem(left = "", right = "") {
  if (items.length >= MAX_ITEMS) return;
  items.push({ left: { text: left, image: null }, right: { text: right, image: null } });
  renderEditor();
}

addButton.addEventListener("click", () => addItem());

editorEl.addEventListener("input", (event) => {
  const input = event.target.closest("[data-side]");
  if (!input) return;
  const row = input.closest("[data-index]");
  items[Number(row.dataset.index)][input.dataset.side].text = input.value;
});

editorEl.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    items.splice(Number(remove.dataset.remove), 1);
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
    const index = Number(picker.dataset.index);
    const side = picker.dataset.side;
    items[index][side].image = uploaded.id;
    previewUrls.set(uploaded.id, URL.createObjectURL(file));
    renderEditor();
    status.dispose();
    showToast("Imagen lista");
  } catch (error) {
    status.dispose();
    showToast(error.message || "No se pudo subir la imagen");
  }
});

// El binario crudo, sin base64 ni multipart: no hace falta ninguna dependencia
// y no se gasta un tercio mas de ancho de banda.
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

// Pegar varias lineas de golpe. Se acepta la flecha que se usaba antes porque
// es lo que ya tienen escrito, pero no es la unica forma de cargar.
bulkApply?.addEventListener("click", () => {
  const lines = bulkField.value.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const separator = line.includes("→") ? "→" : line.includes("->") ? "->" : null;
    if (separator) {
      const parts = line.split(separator);
      addItem(parts[0]?.trim(), parts.slice(1).join(separator).trim());
    } else {
      addItem(line, "");
    }
  }
  bulkField.value = "";
});

document.querySelectorAll('input[name="activity-type"]').forEach((input) => {
  input.addEventListener("change", () => {
    document.querySelector("#entries-label").textContent = isZones()
      ? "Elementos y zonas"
      : "Elementos en el orden correcto";
    renderEditor();
  });
});

// Al crear la sala se manda la lista de items, con la imagen como id.
function buildPayload() {
  const prompt = document.querySelector("#prompt").value;
  if (isZones()) {
    return {
      type: "zones",
      prompt,
      pairs: items.map((item) => ({
        label: item.left.text.trim(),
        target: item.right.text.trim(),
        labelImage: item.left.image,
        targetImage: item.right.image,
      })),
    };
  }
  return {
    type: "sequence",
    prompt,
    items: items.map((item) => ({ text: item.left.text.trim(), image: item.left.image })),
  };
}

// Cuando se vuelve a la pantalla de creacion no queda la actividad anterior.
function resetEditor() {
  items = [];
  renderEditor();
  if (bulkField) bulkField.value = "";
}
// El servidor inyecta el prefijo de publicacion en el HTML (ver BASE_PATH en
// server.js). Con prefijo, el socket tiene que apuntar a /limlimclap/socket.io/:
// si se deja el valor por defecto (/socket.io/) la conexion caeria en la otra
// aplicacion que ocupe la raiz del dominio.
const basePath = window.__LIMLIM_BASE__ || "";
const socket = io({ path: `${basePath}/socket.io/` });
const views = [...document.querySelectorAll(".view")];
const toast = document.querySelector("#toast");
let currentCode = "";
let currentActivity = null;
let selectedTile = null;
let participantName = "";
let dragTile = null;

function showView(id) {
  views.forEach((view) => view.classList.toggle("active", view.id === id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2400);
}

function emitWithAck(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (error, response) => {
      if (error) resolve({ error: "No pudimos conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo." });
      else resolve(response);
    });
  });
}

function getSelectedType() {
  return document.querySelector('input[name="activity-type"]:checked').value;
}

document.querySelector("#show-create").addEventListener("click", () => showView("create-view"));
document.querySelector("#show-join").addEventListener("click", () => showView("join-view"));
document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.go));
});

document.querySelectorAll('input[name="activity-type"]').forEach((input) => {
  input.addEventListener("change", () => {
    document.querySelectorAll(".type-option").forEach((option) => option.classList.remove("selected"));
    input.closest(".type-option").classList.add("selected");
  });
});

document.querySelector("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector("#create-error");
  errorElement.textContent = "";

  // Se revisa ronda por ronda antes de mandar nada: el backend tambien valida,
  // pero avisar acá evita el viaje de ida y vuelta.
  const problem = firstProblem();
  if (problem) {
    errorElement.textContent = problem;
    return;
  }

  const result = await emitWithAck("host:create", buildPayload());
  if (result?.error) {
    errorElement.textContent = result.error;
    return;
  }
  currentCode = result.room.code;
  currentActivity = result.activity;
  renderHost(result.room);
  showView("host-view");
});

function renderHost(room) {
  document.querySelector("#host-code").textContent = room.code;
  const link = new URL(window.location.href);
  link.search = `?join=${room.code}`;
  document.querySelector("#share-link").textContent = link.href;
  document.querySelector("#host-prompt").textContent = room.prompt;
  renderParticipants(room.participants);
  renderLeaderboard(room.participants);
  renderRoundHeader(room);
}

function renderParticipants(participants) {
  document.querySelector("#participant-count").textContent = participants.length;
  document.querySelector("#empty-responses").hidden = participants.length > 0;
  document.querySelector("#participant-list").innerHTML = participants.map((participant) => `
    <div class="participant-row">
      <span class="participant-avatar">${escapeHtml(participant.name.slice(0, 1).toUpperCase())}</span>
      <span>${escapeHtml(participant.name)}</span>
      <span class="participant-status ${participant.submitted ? "done" : ""}">${participant.submitted ? `Respondió · ${participant.score.correct}/${participant.score.total}` : participant.connected ? "Conectado" : "Desconectado"}</span>
    </div>`).join("");
}

// Acumulado entre rondas. Se ordena por puntos y, a igualdad, por quien
// respondio antes en la ultima ronda.
function renderLeaderboard(participants) {
  const scored = participants.filter((participant) => participant.total > 0);
  document.querySelector("#empty-leaderboard").hidden = scored.length > 0;
  const ranked = [...scored].sort((a, b) => b.total - a.total).slice(0, 10);
  document.querySelector("#leaderboard-list").innerHTML = ranked.map((participant, index) => `
    <div class="leaderboard-row">
      <span class="leaderboard-rank">${index + 1}</span>
      <span class="participant-avatar">${escapeHtml(participant.name.slice(0, 1).toUpperCase())}</span>
      <span class="leaderboard-name">${escapeHtml(participant.name)}</span>
      <span class="leaderboard-total">${participant.total} pts</span>
    </div>`).join("");
}

// El indicador de ronda y el boton de avance viven juntos: cuando ya no quedan
// rondas, el boton se deshabilita en vez de desaparecer, para que el layout no
// salte a mitad de la sesion.
function renderRoundHeader(room) {
  document.querySelector("#host-round-label").textContent =
    `Ronda ${room.roundIndex + 1} de ${room.roundsCount}`;
  const nextButton = document.querySelector("#next-round");
  nextButton.disabled = room.roundIndex >= room.roundsCount - 1;
  nextButton.textContent = room.roundIndex >= room.roundsCount - 1
    ? "Última ronda"
    : "Siguiente ronda";
}

document.querySelector("#next-round").addEventListener("click", async () => {
  const result = await emitWithAck("host:next", { code: currentCode });
  if (result?.error) {
    showToast(result.error);
    return;
  }
  showToast(`Ronda ${result.room.roundIndex + 1}`);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

document.querySelector("#copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#share-link").textContent);
    showToast("Enlace copiado");
  } catch {
    showToast("No se pudo copiar. Puedes seleccionar y copiar el enlace.");
  }
});

document.querySelector("#close-room").addEventListener("click", () => {
  socket.emit("host:close", { code: currentCode });
  currentCode = "";
  showView("home-view");
  showToast("La sala se cerró");
});

document.querySelector("#join-code").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

document.querySelector("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector("#join-error");
  errorElement.textContent = "";
  const result = await emitWithAck("participant:join", {
    code: document.querySelector("#join-code").value,
    name: document.querySelector("#join-name").value,
  });
  if (result?.error) {
    errorElement.textContent = result.error;
    return;
  }
  currentCode = result.room.code;
  currentActivity = result.activity;
  participantName = document.querySelector("#join-name").value.trim();
  startActivity();
});

function startActivity() {
  const roundsLabel = currentActivity.roundsCount > 1
    ? `SALA ${currentCode} · RONDA ${currentActivity.roundIndex + 1} de ${currentActivity.roundsCount}`
    : `SALA ${currentCode}`;
  document.querySelector("#participant-room-label").textContent = roundsLabel;
  document.querySelector("#participant-prompt").textContent = currentActivity.prompt;
  document.querySelector("#game-error").textContent = "";
  document.querySelector("#game-feedback").textContent = "Arrastra las piezas o tócalas para colocarlas.";
  document.querySelector("#submit-answer").disabled = false;
  document.querySelector("#submit-answer").textContent = "Enviar respuesta ↗";
  if (currentActivity.type === "zones") renderZones();
  else renderSequence();
  showView("participant-view");
}

function makeTile(item, index) {
  // Acepta texto plano (compatibilidad) o {text, image}.
  const label = typeof item === "string" ? item : item.text;
  const image = typeof item === "string" ? null : item.image;
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.draggable = true;
  tile.dataset.label = label;
  tile.setAttribute("aria-pressed", "false");
  tile.innerHTML = `
    <span class="tile-number">${index + 1}</span>
    ${image ? `<img class="tile-image" src="${imageUrl(image)}" alt="" loading="lazy">` : ""}
    <span>${escapeHtml(label)}</span>`;
  tile.addEventListener("click", () => {
    if (selectedTile === tile) {
      selectTile(null);
      return;
    }
    selectTile(tile);
    if (currentActivity.type === "sequence" && tile.parentElement.classList.contains("sequence-bank")) {
      const slot = [...document.querySelectorAll(".sequence-slot")].find((candidate) => !candidate.querySelector(".tile"));
      if (slot) placeTile(tile, slot);
    } else if (currentActivity.type === "sequence") {
      tile.remove();
      document.querySelector(".sequence-bank").append(tile);
      selectTile(null);
      updateFeedback();
    }
  });
  tile.addEventListener("dragstart", () => {
    dragTile = tile;
    tile.classList.add("dragging");
  });
  tile.addEventListener("dragend", () => {
    tile.classList.remove("dragging");
    dragTile = null;
  });
  return tile;
}

function selectTile(tile) {
  document.querySelectorAll(".tile[aria-pressed='true']").forEach((activeTile) => activeTile.setAttribute("aria-pressed", "false"));
  selectedTile = tile;
  if (tile) tile.setAttribute("aria-pressed", "true");
}

function attachDropTarget(target, onDrop) {
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    target.classList.add("is-over");
  });
  target.addEventListener("dragleave", () => target.classList.remove("is-over"));
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    target.classList.remove("is-over");
    if (dragTile) onDrop(dragTile);
  });
}

function placeTile(tile, target) {
  if (target.classList.contains("sequence-slot")) {
    const existingTile = target.querySelector(".tile");
    if (existingTile && existingTile !== tile) {
      document.querySelector(".sequence-bank").append(existingTile);
      existingTile.classList.remove("in-target");
    }
  }
  target.append(tile);
  tile.classList.add("in-target");
  selectTile(null);
  updateFeedback();
}

function renderZones() {
  const area = document.querySelector("#game-area");
  area.className = "panel game-panel";
  area.innerHTML = `<div class="game-columns"><section><h2 class="game-section-title">Elementos</h2><div class="tile-bank" id="tile-bank"></div></section><section><h2 class="game-section-title">Zonas</h2><div class="target-columns" id="target-columns"></div></section></div>`;
  const bank = area.querySelector("#tile-bank");
  currentActivity.labels.forEach((label, index) => bank.append(makeTile(label, index)));
  currentActivity.targets.forEach((target) => {
    // El backend puede mandar texto o {text, image}.
    const text = typeof target === "string" ? target : target.text;
    const image = typeof target === "string" ? null : target.image;
    const box = document.createElement("div");
    box.className = "target-box";
    box.dataset.target = text;
    box.innerHTML = `
      ${image ? `<img class="target-image" src="${imageUrl(image)}" alt="" loading="lazy">` : ""}
      <span class="target-label">${escapeHtml(text)}</span>`;
    box.addEventListener("click", () => {
      if (selectedTile) placeTile(selectedTile, box);
    });
    attachDropTarget(box, (tile) => placeTile(tile, box));
    area.querySelector("#target-columns").append(box);
  });
  attachDropTarget(bank, (tile) => {
    bank.append(tile);
    tile.classList.remove("in-target");
    updateFeedback();
  });
}

function renderSequence() {
  const area = document.querySelector("#game-area");
  area.className = "panel game-panel sequence-game";
  area.innerHTML = `<h2 class="game-section-title">Tu secuencia</h2><div id="sequence-slots"></div><h2 class="game-section-title">Elementos disponibles</h2><div class="sequence-bank" id="sequence-bank"></div>`;
  const slots = area.querySelector("#sequence-slots");
  currentActivity.items.forEach((_, index) => {
    const slot = document.createElement("div");
    slot.className = "sequence-slot";
    slot.innerHTML = `<span class="slot-number">${index + 1}</span>`;
    slot.addEventListener("click", () => {
      if (selectedTile) placeTile(selectedTile, slot);
    });
    attachDropTarget(slot, (tile) => placeTile(tile, slot));
    slots.append(slot);
  });
  const bank = area.querySelector("#sequence-bank");
  currentActivity.items.forEach((item, index) => bank.append(makeTile(item, index)));
  attachDropTarget(bank, (tile) => {
    bank.append(tile);
    tile.classList.remove("in-target");
    updateFeedback();
  });
}

function updateFeedback() {
  const feedback = document.querySelector("#game-feedback");
  const filled = currentActivity.type === "zones"
    ? [...document.querySelectorAll(".target-box")].reduce((total, box) => total + box.querySelectorAll(".tile").length, 0)
    : [...document.querySelectorAll(".sequence-slot")].filter((slot) => slot.querySelector(".tile")).length;
  const total = currentActivity.type === "zones" ? currentActivity.labels.length : currentActivity.items.length;
  feedback.textContent = `${filled} de ${total} elementos colocados`;
}

function getAnswer() {
  if (currentActivity.type === "zones") {
    const answer = Object.create(null);
    document.querySelectorAll(".target-box").forEach((box) => {
      box.querySelectorAll(".tile").forEach((tile) => { answer[tile.dataset.label] = box.dataset.target; });
    });
    return Object.keys(answer).length === currentActivity.labels.length ? answer : null;
  }
  const slots = [...document.querySelectorAll(".sequence-slot")];
  if (slots.some((slot) => !slot.querySelector(".tile"))) return null;
  return slots.map((slot) => slot.querySelector(".tile").dataset.label);
}

document.querySelector("#submit-answer").addEventListener("click", async () => {
  const errorElement = document.querySelector("#game-error");
  errorElement.textContent = "";
  const answer = getAnswer();
  if (!answer) {
    errorElement.textContent = "Coloca todos los elementos antes de enviar.";
    return;
  }
  const result = await emitWithAck("participant:submit", { code: currentCode, answer });
  if (result?.error) {
    errorElement.textContent = result.error;
    return;
  }
  showResult(result.score);
});

function showResult(score) {
  document.querySelector("#result-title").textContent = `¡Gracias, ${participantName}!`;
  document.querySelector("#result-message").textContent = "Tu respuesta ya llegó al anfitrión.";
  document.querySelector("#result-score").textContent = `${score.correct} de ${score.total} correctos`;
  showView("result-view");
}

socket.on("room:update", (room) => {
  if (room.code !== currentCode) return;
  const onHostView = document.querySelector("#host-view").classList.contains("active");
  if (!onHostView) return;
  renderParticipants(room.participants);
  renderLeaderboard(room.participants);
  renderRoundHeader(room);
  document.querySelector("#host-prompt").textContent = room.prompt;
});

// El host avanza de ronda: el participante recibe la nueva consigna solo, sin
// volver a entrar con el codigo.
socket.on("round:changed", (payload) => {
  if (payload.room.code !== currentCode) return;
  currentActivity = payload.activity;
  if (document.querySelector("#participant-view").classList.contains("active")) {
    startActivity();
    showToast(`Ronda ${payload.activity.roundIndex + 1}: ${payload.activity.prompt}`);
  }
  if (document.querySelector("#host-view").classList.contains("active")) {
    renderParticipants(payload.room.participants);
    renderLeaderboard(payload.room.participants);
    renderRoundHeader(payload.room);
    document.querySelector("#host-prompt").textContent = payload.room.prompt;
  }
});

socket.on("room:closed", () => {
  if (document.querySelector("#participant-view").classList.contains("active")) {
    showView("home-view");
    showToast("El anfitrión cerró esta actividad");
  }
});

const inviteCode = new URLSearchParams(window.location.search).get("join");
if (inviteCode) {
  document.querySelector("#join-code").value = inviteCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  showView("join-view");
}

document.querySelector("#entries").placeholder = "París → Francia\nTokio → Japón\nLima → Perú";

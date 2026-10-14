const BASE_PATH = (window.__LIMLIM_BASE__ || "").replace(/\/$/, "");
const socket = io({ path: `${BASE_PATH}/socket.io/` });
const views = [...document.querySelectorAll(".view")];
const toast = document.querySelector("#toast");

const templates = [
  {
    name: "Capitales",
    type: "zones",
    prompt: "Relaciona cada ciudad con su país",
    entries: "París → Francia\nTokio → Japón\nLima → Perú\nBogotá → Colombia",
    timeLimit: 60,
    theme: "green",
  },
  {
    name: "Ciclo",
    type: "sequence",
    prompt: "Ordena el ciclo del agua",
    entries: "Evaporación\nCondensación\nPrecipitación\nInfiltración",
    timeLimit: 120,
    theme: "blue",
  },
  {
    name: "Banderas",
    type: "zones",
    prompt: "Empareja cada bandera con su país",
    entries: "Francia [img:https://flagcdn.com/w80/fr.png] → Europa\nJapón [img:https://flagcdn.com/w80/jp.png] → Asia\nPerú [img:https://flagcdn.com/w80/pe.png] → América\nKenia [img:https://flagcdn.com/w80/ke.png] → África",
    timeLimit: 60,
    theme: "coral",
  },
  {
    name: "Método científico",
    type: "sequence",
    prompt: "Ordena el método científico",
    entries: "Observación\nHipótesis\nExperimentación\nAnálisis\nConclusión",
    timeLimit: 180,
    theme: "violet",
  },
];

let currentCode = "";
let hostToken = sessionStorage.getItem("limlimclap:host-token") || "";
let participantToken = sessionStorage.getItem("limlimclap:participant-token") || "";
let currentActivity = null;
let currentBgImage = "";
let selectedTile = null;
let participantName = "";
let dragTile = null;
let soundEnabled = localStorage.getItem("limlimclap:sound") === "1";
let timerInterval = null;
let currentStatus = "";
let confettiBurstDone = false;

const audioCtx = typeof AudioContext !== "undefined" ? new AudioContext() : null;

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
    socket.timeout(30000).emit(event, payload, (error, response) => {
      if (error) resolve({ error: "No pudimos conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo." });
      else resolve(response);
    });
  });
}

function getSelectedType() {
  return document.querySelector('input[name="activity-type"]:checked').value;
}

function getSelectedTheme() {
  return document.querySelector('input[name="theme"]:checked').value;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || "green";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function haptic(pattern = 25) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {}
  }
}

function initDarkMode() {
  const toggleBtn = document.querySelector("#theme-toggle");
  if (!toggleBtn) return;
  const saved = localStorage.getItem("limlimclap:dark-mode");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = saved !== null ? saved === "1" : prefersDark;
  document.body.classList.toggle("dark-mode", isDark);
  toggleBtn.textContent = isDark ? "☀️" : "🌙";
  toggleBtn.setAttribute("aria-pressed", String(isDark));
  toggleBtn.setAttribute("aria-label", isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");

  toggleBtn.addEventListener("click", () => {
    const currentlyDark = document.body.classList.toggle("dark-mode");
    localStorage.setItem("limlimclap:dark-mode", currentlyDark ? "1" : "0");
    toggleBtn.textContent = currentlyDark ? "☀️" : "🌙";
    toggleBtn.setAttribute("aria-pressed", String(currentlyDark));
    toggleBtn.setAttribute("aria-label", currentlyDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
    showToast(currentlyDark ? "Modo oscuro activado" : "Modo claro activado");
    haptic(15);
  });
}

function playTone(type = "ok") {
  haptic(type === "ok" ? 20 : [60, 40, 60]);
  if (!soundEnabled || !audioCtx) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.connect(audioCtx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  const osc = audioCtx.createOscillator();
  osc.type = type === "ok" ? "triangle" : "square";
  osc.frequency.setValueAtTime(type === "ok" ? 830 : 300, now);
  osc.frequency.exponentialRampToValueAtTime(type === "ok" ? 1240 : 210, now + 0.25);
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + 0.35);
}

function renderTemplates() {
  const row = document.querySelector("#template-row");
  row.innerHTML = templates
    .map(
      (template, index) => `<button class="template-pill" type="button" data-template="${index}">${escapeHtml(template.name)}</button>`,
    )
    .join("");
  row.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const template = templates[Number(button.dataset.template)];
      loadActivityIntoForm(template);
      saveCurrentFormToActiveQuestion();
      showToast(`Plantilla "${template.name}" cargada`);
    });
  });
}

let quizQuestions = [
  {
    type: "zones",
    prompt: "",
    entries: "",
    timeLimit: 0,
    theme: "green",
    bgImage: "",
  },
];
let activeQuestionIndex = 0;

function getCurrentFormActivity() {
  const type = getSelectedType();
  return {
    type,
    prompt: document.querySelector("#prompt").value,
    entries: document.querySelector("#entries").value,
    timeLimit: Number(document.querySelector("#time-limit").value),
    theme: getSelectedTheme(),
    bgImage: currentBgImage,
  };
}

function loadActivityIntoForm(act) {
  document.querySelector(`#type-${act.type}`).checked = true;
  setTypeUI(act.type);
  document.querySelector("#prompt").value = act.prompt || "";
  document.querySelector("#entries").value = act.entries || "";
  document.querySelector("#time-limit").value = String(act.timeLimit ?? 0);
  const themeInput = document.querySelector(`input[name='theme'][value='${act.theme || "green"}']`);
  if (themeInput) themeInput.checked = true;
  currentBgImage = act.bgImage || "";
  const bgPreviewWrap = document.querySelector("#bg-preview-wrap");
  const bgPreview = document.querySelector("#bg-preview");
  const bgFileName = document.querySelector("#bg-file-name");
  const btnClearBg = document.querySelector("#btn-clear-bg");
  if (currentBgImage) {
    bgPreview.src = currentBgImage;
    bgPreviewWrap.hidden = false;
    btnClearBg.hidden = false;
    bgFileName.textContent = "Imagen cargada";
  } else {
    bgPreview.src = "";
    bgPreviewWrap.hidden = true;
    btnClearBg.hidden = true;
    bgFileName.textContent = "Ninguna imagen seleccionada";
  }
}

function saveCurrentFormToActiveQuestion() {
  quizQuestions[activeQuestionIndex] = getCurrentFormActivity();
}

function renderQuestionTabs() {
  const tabsContainer = document.querySelector("#questions-tabs");
  if (!tabsContainer) return;
  tabsContainer.innerHTML = quizQuestions
    .map(
      (_, index) => `
      <button type="button" class="question-tab-btn ${index === activeQuestionIndex ? "active" : ""}" data-q-tab="${index}">
        Pregunta ${index + 1}
      </button>`,
    )
    .join("");

  if (quizQuestions.length < 10) {
    tabsContainer.insertAdjacentHTML(
      "beforeend",
      `<button type="button" class="question-tab-add" id="btn-add-question">+ Añadir pregunta</button>`,
    );
  }

  if (quizQuestions.length > 1) {
    tabsContainer.insertAdjacentHTML(
      "beforeend",
      `<button type="button" class="button button-secondary" id="btn-remove-question">✕ Eliminar</button>`,
    );
  }

  tabsContainer.querySelectorAll("[data-q-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.qTab);
      if (idx === activeQuestionIndex) return;
      saveCurrentFormToActiveQuestion();
      activeQuestionIndex = idx;
      loadActivityIntoForm(quizQuestions[activeQuestionIndex]);
      renderQuestionTabs();
    });
  });

  const btnAdd = document.querySelector("#btn-add-question");
  if (btnAdd) {
    btnAdd.addEventListener("click", () => {
      saveCurrentFormToActiveQuestion();
      quizQuestions.push({
        type: "zones",
        prompt: "",
        entries: "",
        timeLimit: 0,
        theme: "green",
        bgImage: "",
      });
      activeQuestionIndex = quizQuestions.length - 1;
      loadActivityIntoForm(quizQuestions[activeQuestionIndex]);
      renderQuestionTabs();
      showToast(`Pregunta ${quizQuestions.length} añadida`);
    });
  }

  const btnRemove = document.querySelector("#btn-remove-question");
  if (btnRemove) {
    btnRemove.addEventListener("click", () => {
      if (quizQuestions.length <= 1) return;
      quizQuestions.splice(activeQuestionIndex, 1);
      activeQuestionIndex = Math.max(0, activeQuestionIndex - 1);
      loadActivityIntoForm(quizQuestions[activeQuestionIndex]);
      renderQuestionTabs();
      showToast("Pregunta eliminada");
    });
  }
}

function formatActivityForForm(data) {
  if (data.entries) return data;
  if (data.type === "zones" && Array.isArray(data.pairs)) {
    const lines = data.pairs.map((p) => {
      const img = p.image ? ` [img:${p.image}]` : "";
      return `${p.label}${img} → ${p.target}`;
    });
    return {
      type: "zones",
      prompt: data.prompt || "",
      entries: lines.join("\n"),
      timeLimit: data.timeLimit || 0,
      theme: data.theme || "green",
      bgImage: data.bgImage || "",
    };
  }
  if (data.type === "sequence" && Array.isArray(data.items)) {
    const lines = data.items.map((it) => {
      if (typeof it === "object" && it !== null) {
        const img = it.image ? ` [img:${it.image}]` : "";
        return `${it.text || it.label}${img}`;
      }
      return String(it);
    });
    return {
      type: "sequence",
      prompt: data.prompt || "",
      entries: lines.join("\n"),
      timeLimit: data.timeLimit || 0,
      theme: data.theme || "blue",
      bgImage: data.bgImage || "",
    };
  }
  return {
    type: data.type || "zones",
    prompt: data.prompt || "",
    entries: "",
    timeLimit: 0,
    theme: "green",
    bgImage: "",
  };
}

function getCustomTemplates() {
  try {
    return JSON.parse(localStorage.getItem("limlimclap:custom-templates") || "[]");
  } catch {
    return [];
  }
}

function saveCustomTemplate() {
  const prompt = document.querySelector("#prompt").value.trim();
  const entries = document.querySelector("#entries").value.trim();
  if (!prompt || !entries) {
    showToast("Escribe una consigna y elementos antes de guardar");
    return;
  }
  const name = window.prompt("Nombre para tu plantilla:", prompt.slice(0, 30))?.trim();
  if (!name) return;
  const current = getCurrentFormActivity();
  const customList = getCustomTemplates();
  customList.push({ name, ...current });
  localStorage.setItem("limlimclap:custom-templates", JSON.stringify(customList));
  renderCustomTemplates();
  showToast(`Plantilla "${name}" guardada`);
}

function renderCustomTemplates() {
  const container = document.querySelector("#my-templates-row");
  const chips = document.querySelector("#my-templates-chips");
  const customList = getCustomTemplates();
  if (!customList.length) {
    container.hidden = true;
    chips.innerHTML = "";
    return;
  }
  container.hidden = false;
  chips.innerHTML = customList
    .map(
      (t, index) => `
      <div class="saved-template-chip">
        <span class="chip-name" data-load-template="${index}" style="cursor:pointer">${escapeHtml(t.name)}</span>
        <button type="button" data-del-template="${index}" title="Eliminar plantilla">✕</button>
      </div>`,
    )
    .join("");

  chips.querySelectorAll("[data-load-template]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.loadTemplate);
      const t = customList[idx];
      if (t) {
        loadActivityIntoForm(t);
        saveCurrentFormToActiveQuestion();
        showToast(`Plantilla "${t.name}" cargada`);
      }
    });
  });

  chips.querySelectorAll("[data-del-template]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.delTemplate);
      const list = getCustomTemplates();
      list.splice(idx, 1);
      localStorage.setItem("limlimclap:custom-templates", JSON.stringify(list));
      renderCustomTemplates();
      showToast("Plantilla eliminada");
    });
  });
}

function exportQuizJSON() {
  saveCurrentFormToActiveQuestion();
  const data = quizQuestions.length > 1 ? { activities: quizQuestions } : getCurrentFormActivity();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Limlimclap_actividad_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Actividad exportada a JSON");
}

function importQuizJSON(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data?.activities) && data.activities.length > 0) {
        quizQuestions = data.activities.map((a) => formatActivityForForm(a));
        activeQuestionIndex = 0;
        loadActivityIntoForm(quizQuestions[0]);
        renderQuestionTabs();
        showToast(`${quizQuestions.length} preguntas importadas`);
      } else if (data?.prompt) {
        const act = formatActivityForForm(data);
        quizQuestions = [act];
        activeQuestionIndex = 0;
        loadActivityIntoForm(act);
        renderQuestionTabs();
        showToast("Actividad importada");
      } else {
        showToast("El archivo JSON no tiene un formato reconocido");
      }
    } catch {
      showToast("Error al procesar el archivo JSON");
    }
  };
  reader.readAsText(file);
}

function setTypeUI(type) {
  document.querySelectorAll(".type-option").forEach((option) => option.classList.remove("selected"));
  document.querySelector(`#type-${type}`).closest(".type-option").classList.add("selected");
  const isZones = type === "zones";
  document.querySelector("#entries-label").textContent = isZones ? "Elementos y respuestas" : "Elementos en el orden correcto";
  document.querySelector("#entries").placeholder = isZones
    ? "París → Francia\nTokio [img:https://ejemplo.com/tokio.jpg] → Japón\nLima → Perú"
    : "Primero\nSegundo [img:https://ejemplo.com/dos.jpg]\nAl final";
  document.querySelector("#entries-hint").innerHTML = isZones
    ? 'Una relación por línea: <code>Elemento → Zona</code>. Puedes añadir imagen con <code>[img:url]</code> (ej. <code>París [img:url] → Francia</code>).'
    : 'Un elemento por línea en orden. Puedes añadir imagen con <code>[img:url]</code> (ej. <code>Paso 1 [img:url]</code>).';
}

function parseItem(text) {
  if (!text) return { label: "", image: "" };
  const imgMatch = text.match(/\[img:(https?:\/\/[^\]\s]+)\]/i);
  if (imgMatch) {
    const image = imgMatch[1].trim();
    const cleanLabel = text.replace(imgMatch[0], "").trim();
    return { label: cleanLabel, image };
  }
  return { label: text.trim(), image: "" };
}

function parseEntries(type, rawText) {
  const textVal = rawText !== undefined ? rawText : document.querySelector("#entries").value;
  const lines = textVal
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (type === "zones") {
    return lines.map((line) => {
      const separator = line.includes("→") ? "→" : "->";
      const parts = line.split(separator);
      const rawLabel = parts[0]?.trim() || "";
      const target = parts.slice(1).join(separator).trim();
      const parsed = parseItem(rawLabel);
      return {
        label: parsed.label,
        target,
        ...(parsed.image ? { image: parsed.image } : {}),
      };
    });
  }
  return lines.map((line) => {
    const parsed = parseItem(line);
    return {
      text: parsed.label,
      ...(parsed.image ? { image: parsed.image } : {}),
    };
  });
}

function activityObjectFromData(data) {
  const parsed = parseEntries(data.type, data.entries);
  return {
    type: data.type,
    prompt: data.prompt,
    theme: data.theme,
    timeLimit: data.timeLimit,
    ...(data.bgImage ? { bgImage: data.bgImage } : {}),
    ...(data.type === "zones" ? { pairs: parsed } : { items: parsed }),
  };
}

function mountConfetti() {
  const host = document.createElement("div");
  host.className = "confetti-host";
  for (let i = 0; i < 60; i += 1) {
    const piece = document.createElement("i");
    piece.className = `p${i % 10}`;
    host.append(piece);
  }
  document.body.append(host);
  window.setTimeout(() => host.remove(), 2600);
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function setTimer(labelId, remainingMs) {
  const node = document.querySelector(labelId);
  if (!node) return;
  if (remainingMs === null || remainingMs === undefined) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = `⏱ ${formatTime(remainingMs)}`;
}

function startTicker(getRemaining, callback) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const ms = getRemaining();
    callback(ms);
  }, 250);
}

function stopTicker() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updateSoundButton() {
  const button = document.querySelector("#sound-toggle");
  button.textContent = soundEnabled ? "🔊" : "🔇";
  button.setAttribute("aria-pressed", String(soundEnabled));
  button.setAttribute("aria-label", soundEnabled ? "Desactivar sonido" : "Activar sonido");
}

function saveTokens() {
  if (hostToken) sessionStorage.setItem("limlimclap:host-token", hostToken);
  if (participantToken) sessionStorage.setItem("limlimclap:participant-token", participantToken);
}

function clearParticipantToken() {
  participantToken = "";
  sessionStorage.removeItem("limlimclap:participant-token");
}

function renderParticipants(participants) {
  const list = document.querySelector("#participant-list");
  const scored = participants
    .filter((p) => p.score || (p.totalPoints && p.totalPoints > 0))
    .sort((a, b) => {
      const ptsA = a.totalPoints || a.score?.points || 0;
      const ptsB = b.totalPoints || b.score?.points || 0;
      if (ptsB !== ptsA) return ptsB - ptsA;
      const corA = a.totalCorrect || a.score?.correct || 0;
      const corB = b.totalCorrect || b.score?.correct || 0;
      return corB - corA;
    })
    .concat(participants.filter((p) => !p.score && (!p.totalPoints || p.totalPoints === 0)));

  document.querySelector("#participant-count").textContent = participants.length;
  document.querySelector("#empty-responses").hidden = participants.length > 0;

  list.innerHTML = scored
    .map((participant, index) => {
      const isScored = participant.score || (participant.totalPoints && participant.totalPoints > 0);
      const position = isScored ? `<span class="position">#${index + 1}</span>` : "";
      const pts = participant.totalPoints || participant.score?.points || 0;
      const cor = participant.totalCorrect || participant.score?.correct || 0;
      const tot = participant.totalPossible || participant.score?.total || 0;
      const status = isScored
        ? `${pts.toLocaleString()} pts · ${cor}/${tot}`
        : participant.connected
          ? "Conectado"
          : "Desconectado";
      return `<div class="participant-row ${participant.score ? "submitted" : ""}">
        <span class="participant-avatar">${escapeHtml(participant.name.slice(0, 1).toUpperCase())}</span>
        <span class="participant-name">${escapeHtml(participant.name)}</span>
        ${position}
        <span class="participant-status ${participant.score ? "done" : ""}">${status}</span>
        <button class="icon-button kick" type="button" data-kick="${participant.id}" aria-label="Retirar ${escapeHtml(participant.name)}">✕</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-kick]").forEach((button) => {
    button.addEventListener("click", () => socket.emit("host:kick", { id: button.dataset.kick }));
  });
}

function renderStats(stats) {
  const panel = document.querySelector("#stats-panel");
  const list = document.querySelector("#stats-list");
  if (!stats?.length) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }
  panel.hidden = false;
  list.innerHTML = stats
    .map((entry) => {
      const percent = entry.answered ? Math.round((entry.correct / entry.answered) * 100) : 0;
      return `<div class="stat-row">
        <div class="stat-label" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
        <progress class="stat-bar" max="100" value="${percent}" aria-label="Aciertos en ${escapeHtml(entry.name)}"></progress>
        <strong>${percent}%</strong>
      </div>`;
    })
    .join("");
}

let lastHostRoom = null;

function renderPodium(containerSelector, listSelector, rankedParticipants) {
  const wrap = document.querySelector(containerSelector);
  const podium = document.querySelector(listSelector);
  if (!wrap || !podium) return;
  if (!rankedParticipants || rankedParticipants.length === 0) {
    wrap.hidden = true;
    podium.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  const top3 = rankedParticipants.slice(0, 3);
  const first = top3[0];
  const second = top3[1];
  const third = top3[2];

  let html = "";
  if (second) {
    const pts = (second.totalPoints || second.score?.points || second.points || 0).toLocaleString();
    html += `
      <div class="podium-place podium-second">
        <span class="podium-avatar">🥈</span>
        <span class="podium-name" title="${escapeHtml(second.name)}">${escapeHtml(second.name)}</span>
        <span class="podium-points">${pts} pts</span>
        <div class="podium-pedestal"><span class="podium-rank-num">2</span></div>
      </div>`;
  }
  if (first) {
    const pts = (first.totalPoints || first.score?.points || first.points || 0).toLocaleString();
    html += `
      <div class="podium-place podium-first">
        <span class="podium-avatar">👑 🥇</span>
        <span class="podium-name" title="${escapeHtml(first.name)}">${escapeHtml(first.name)}</span>
        <span class="podium-points">${pts} pts</span>
        <div class="podium-pedestal"><span class="podium-rank-num">1</span></div>
      </div>`;
  }
  if (third) {
    const pts = (third.totalPoints || third.score?.points || third.points || 0).toLocaleString();
    html += `
      <div class="podium-place podium-third">
        <span class="podium-avatar">🥉</span>
        <span class="podium-name" title="${escapeHtml(third.name)}">${escapeHtml(third.name)}</span>
        <span class="podium-points">${pts} pts</span>
        <div class="podium-pedestal"><span class="podium-rank-num">3</span></div>
      </div>`;
  }
  podium.innerHTML = html;
}

function exportRoomToCSV(room) {
  if (!room) return;
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `Limlimclap_${room.code}_${dateStr}.csv`;
  const rows = [
    ["Puesto", "Nombre", "Puntos Totales", "Aciertos", "Total Elementos", "Tiempo (s)", "Estado"],
  ];
  const participants = [...(room.participants || [])]
    .filter((p) => p.submitted || p.score)
    .sort((a, b) => (b.totalPoints || b.score?.points || 0) - (a.totalPoints || a.score?.points || 0));

  participants.forEach((p, index) => {
    rows.push([
      index + 1,
      `"${(p.name || "").replace(/"/g, '""')}"`,
      p.totalPoints || p.score?.points || 0,
      p.score ? p.score.correct : (p.totalCorrect || 0),
      p.score ? p.score.total : (p.totalPossible || 0),
      p.score?.timeSeconds != null ? p.score.timeSeconds : "-",
      p.submitted ? "Respondió" : "En espera",
    ]);
  });

  const csvContent = "\uFEFF" + rows.map((e) => e.join(";")).join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Resultados descargados en CSV");
}

function renderHost(room) {
  lastHostRoom = room;
  currentCode = room.code;
  applyTheme(room.theme);
  currentStatus = room.status;
  document.querySelector("#host-code").textContent = room.code;

  const questionIndicator = room.totalActivities > 1
    ? `[Pregunta ${room.activityIndex + 1} de ${room.totalActivities}] `
    : "";
  document.querySelector("#host-prompt").textContent = `${questionIndicator}${room.prompt}`;

  const link = new URL(window.location.href);
  link.search = `?join=${room.code}`;
  document.querySelector("#share-link").textContent = link.href;
  document.querySelector("#host-qr").src = `/qr/${room.code}.svg`;
  renderParticipants(room.participants);
  renderStats(room.stats);

  const statusLabel = room.status === "lobby"
    ? "SALA EN ESPERA"
    : room.status === "live"
      ? `EN DIRECTO ${room.totalActivities > 1 ? `(${room.activityIndex + 1}/${room.totalActivities})` : ""}`
      : "SALA FINALIZADA";
  document.querySelector("#host-status").textContent = statusLabel;
  document.querySelector("#host-title").textContent =
    room.status === "lobby"
      ? "Tu actividad está lista."
      : room.status === "live"
        ? `Actividad en progreso ${room.totalActivities > 1 ? `(${room.activityIndex + 1}/${room.totalActivities})` : ""}`
        : "Actividad finalizada";
  document.querySelector("#host-subtitle").textContent =
    room.status === "lobby"
      ? "Comparte el código o el QR y empieza cuando todos estén dentro."
      : room.status === "live"
        ? "Las respuestas están llegando en directo."
        : "Puedes avanzar a la siguiente pregunta o ver el ranking final.";

  document.querySelector("#start-activity").hidden = room.status !== "lobby";
  document.querySelector("#end-activity").hidden = room.status !== "live";
  document.querySelector("#reset-activity").hidden = room.status === "live";

  const nextBtn = document.querySelector("#next-activity");
  if (nextBtn) {
    nextBtn.hidden = !(room.status === "ended" && !room.isLastActivity);
  }

  const exportBtn = document.querySelector("#export-csv");
  if (exportBtn) {
    exportBtn.hidden = room.status !== "ended";
  }

  const scoredList = (room.participants || [])
    .filter((p) => p.score || (p.totalPoints && p.totalPoints > 0))
    .sort((a, b) => (b.totalPoints || b.score?.points || 0) - (a.totalPoints || a.score?.points || 0));
  if (room.status === "ended") {
    renderPodium("#host-podium-wrap", "#host-podium", scoredList);
  } else {
    const wrap = document.querySelector("#host-podium-wrap");
    if (wrap) wrap.hidden = true;
  }

  setTimer("#host-timer", room.remainingMs);
  if (room.remainingMs != null) {
    const deadline = Date.now() + room.remainingMs;
    startTicker(
      () => Math.max(0, deadline - Date.now()),
      (ms) => setTimer("#host-timer", ms),
    );
  } else {
    stopTicker();
  }
}

function renderLobby(state) {
  currentStatus = "lobby";
  applyTheme(state.theme);
  document.querySelector("#lobby-code").textContent = state.code;
  document.querySelector("#lobby-title").textContent = `¡${participantName || state.name}, ya estás dentro!`;
  showView("lobby-view");
}

function selectTile(tile) {
  document.querySelectorAll(".tile[aria-pressed='true']").forEach((activeTile) =>
    activeTile.setAttribute("aria-pressed", "false"),
  );
  selectedTile = tile;
  if (tile) tile.setAttribute("aria-pressed", "true");
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
  tile.classList.add("pop");
  window.setTimeout(() => tile.classList.remove("pop"), 220);
  selectTile(null);
  updateFeedback();
  playTone("ok");
}

function makeTile(item, index) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.draggable = true;
  const label = typeof item === "object" && item !== null ? (item.label || item.text || "") : String(item);
  const image = typeof item === "object" && item !== null ? (item.image || "") : "";
  tile.dataset.label = label;
  tile.setAttribute("aria-pressed", "false");
  const imgHtml = image ? `<img class="tile-img" src="${escapeHtml(image)}" alt="${escapeHtml(label)}">` : "";
  tile.innerHTML = `<span class="tile-number">${index + 1}</span>${imgHtml}<span>${escapeHtml(label)}</span>`;

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

function renderZones() {
  const area = document.querySelector("#game-area");
  area.className = "panel game-panel";
  const bgBanner = currentActivity.bgImage
    ? `<div class="game-bg-banner"><img src="${escapeHtml(currentActivity.bgImage)}" alt="Diagrama o fondo de la actividad"></div>`
    : "";
  area.innerHTML = `
    ${bgBanner}
    <div class="game-columns">
      <section><h2 class="game-section-title">Elementos</h2><div class="tile-bank" id="tile-bank"></div></section>
      <section><h2 class="game-section-title">Zonas</h2><div class="target-columns" id="target-columns"></div></section>
    </div>`;
  const bank = area.querySelector("#tile-bank");
  currentActivity.labels.forEach((label, index) => bank.append(makeTile(label, index)));
  currentActivity.targets.forEach((target) => {
    const box = document.createElement("div");
    box.className = "target-box";
    box.dataset.target = target;
    box.innerHTML = `<span class="target-label">${escapeHtml(target)}</span>`;
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
  const bgBanner = currentActivity.bgImage
    ? `<div class="game-bg-banner"><img src="${escapeHtml(currentActivity.bgImage)}" alt="Diagrama o fondo de la actividad"></div>`
    : "";
  area.innerHTML = `
    ${bgBanner}
    <h2 class="game-section-title">Tu secuencia</h2>
    <div id="sequence-slots"></div>
    <h2 class="game-section-title">Elementos disponibles</h2>
    <div class="sequence-bank" id="sequence-bank"></div>`;
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
  const filled =
    currentActivity.type === "zones"
      ? [...document.querySelectorAll(".target-box")].reduce((total, box) => total + box.querySelectorAll(".tile").length, 0)
      : [...document.querySelectorAll(".sequence-slot")].filter((slot) => slot.querySelector(".tile")).length;
  const total = currentActivity.type === "zones" ? currentActivity.labels.length : currentActivity.items.length;
  feedback.textContent = `${filled} de ${total} elementos colocados`;

  if (currentActivity.type === "zones") {
    document.querySelectorAll(".target-box").forEach((box) => {
      const count = box.querySelectorAll(".tile").length;
      let countTag = box.querySelector(".target-count");
      if (!countTag) {
        countTag = document.createElement("span");
        countTag.className = "target-count";
        const labelEl = box.querySelector(".target-label");
        if (labelEl) labelEl.append(countTag);
      }
      countTag.textContent = count > 0 ? ` (${count})` : "";
    });
  }
}

function getAnswer() {
  if (currentActivity.type === "zones") {
    const answer = Object.create(null);
    document.querySelectorAll(".target-box").forEach((box) => {
      box.querySelectorAll(".tile").forEach((tile) => {
        answer[tile.dataset.label] = box.dataset.target;
      });
    });
    return Object.keys(answer).length === currentActivity.labels.length ? answer : null;
  }
  const slots = [...document.querySelectorAll(".sequence-slot")];
  if (slots.some((slot) => !slot.querySelector(".tile"))) return null;
  return slots.map((slot) => slot.querySelector(".tile").dataset.label);
}

function renderResultsList(results) {
  const list = document.querySelector("#result-feedback");
  list.innerHTML = (results || [])
    .map(
      (item) => `<li class="${item.ok ? "ok" : "bad"}">
        <span>${escapeHtml(item.name)}</span>
        <span>${item.ok ? "✓" : `✕ ${escapeHtml(item.chosen)} → ${escapeHtml(item.expected)}`}</span>
      </li>`,
    )
    .join("");
}

function renderFinalBoard(board, rank, answered) {
  const container = document.querySelector("#final-board");
  const list = document.querySelector("#final-board-list");
  if (!board?.length) {
    container.hidden = true;
    list.innerHTML = "";
    const wrap = document.querySelector("#result-podium-wrap");
    if (wrap) wrap.hidden = true;
    return;
  }
  container.hidden = false;
  list.innerHTML = board
    .map((entry, index) => {
      const pts = entry.points != null
        ? `<strong>${entry.points.toLocaleString()} pts (${entry.correct}/${entry.total})</strong>`
        : `<strong>${entry.correct}/${entry.total}</strong>`;
      return `<li><span>#${index + 1} ${escapeHtml(entry.name)}</span>${pts}</li>`;
    })
    .join("");

  renderPodium("#result-podium-wrap", "#result-podium", board);

  if (rank) {
    document.querySelector("#result-message").textContent = `Quedaste en el puesto #${rank} de ${answered} participantes con respuesta.`;
  }
}

function showResult(score, results, context = {}) {
  if (!confettiBurstDone) {
    mountConfetti();
    confettiBurstDone = true;
  }
  playTone("ok");
  document.querySelector("#result-mark").textContent = score.correct === score.total ? "🏆" : "✓";
  document.querySelector("#result-eyebrow").textContent = context.ended ? "ACTIVIDAD FINALIZADA" : "RESPUESTA ENVIADA";
  document.querySelector("#result-title").textContent = `¡Gracias, ${participantName}!`;
  if (!context.ended) {
    document.querySelector("#result-message").textContent = "Tu respuesta ya llegó al anfitrión.";
  }

  const speedTxt = score.speedBonus > 0 ? `<br><small style="color:var(--muted);font-size:12px;">¡+${score.speedBonus} pts por responder rápido! ⚡</small>` : "";
  const pointsTxt = score.points ? ` · <span class="points-pill">★ +${score.points.toLocaleString()} pts</span>${speedTxt}` : "";
  document.querySelector("#result-score").innerHTML = `<span>${score.correct} de ${score.total} correctos</span>${pointsTxt}`;

  renderResultsList(results);
  renderFinalBoard(context.board, context.rank, context.answered);
  document.querySelector("#leave-room").hidden = !context.ended;
  showView("result-view");
}

function spawnFloatingEmoji(emoji) {
  const overlay = document.querySelector("#reactions-overlay");
  if (!overlay) return;
  const span = document.createElement("span");
  span.className = "floating-emoji";
  span.textContent = emoji;
  const leftPercent = 15 + Math.random() * 70;
  span.style.left = `${leftPercent}%`;
  overlay.append(span);
  window.setTimeout(() => span.remove(), 2450);
}

function setupReactions() {
  document.querySelectorAll(".reaction-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const emoji = button.dataset.emoji;
      if (!emoji) return;
      haptic(20);
      button.style.transform = "scale(1.4)";
      setTimeout(() => (button.style.transform = ""), 150);
      socket.emit("room:react", { emoji });
    });
  });
}

function startActivity(state) {
  currentStatus = "live";
  confettiBurstDone = false;
  applyTheme(state.theme);
  currentActivity = state.activity;
  document.querySelector("#participant-room-label").textContent = `SALA ${state.code}`;
  document.querySelector("#participant-prompt").textContent = currentActivity.prompt;
  document.querySelector("#game-error").textContent = "";
  document.querySelector("#game-feedback").textContent = "Arrastra las piezas o tócalas para colocarlas.";
  document.querySelector("#submit-answer").disabled = false;
  if (currentActivity.type === "zones") renderZones();
  else renderSequence();
  setTimer("#participant-timer", state.remainingMs);
  if (state.remainingMs != null) {
    const deadline = Date.now() + state.remainingMs;
    startTicker(
      () => Math.max(0, deadline - Date.now()),
      (ms) => {
        setTimer("#participant-timer", ms);
        if (ms === 0 && currentStatus === "live") document.querySelector("#submit-answer").disabled = true;
      },
    );
  }
  showView("participant-view");
}

function applyParticipantState(state) {
  currentCode = state.code;
  participantName = state.name || participantName;
  applyTheme(state.theme);
  if (state.status === "lobby") {
    stopTicker();
    renderLobby(state);
    return;
  }
  if (state.status === "live" && state.activity && !state.score) {
    startActivity(state);
    return;
  }
  if (state.score) {
    stopTicker();
    showResult(state.score, state.results, {
      ended: state.status === "ended",
      board: state.leaderboard,
      rank: state.rank,
      answered: state.answered,
    });
    return;
  }
  if (state.status === "ended") {
    stopTicker();
    document.querySelector("#result-mark").textContent = "⏱";
    document.querySelector("#result-eyebrow").textContent = "ACTIVIDAD FINALIZADA";
    document.querySelector("#result-title").textContent = "El tiempo terminó";
    document.querySelector("#result-message").textContent = "No alcanzaste a enviar respuesta esta vez.";
    document.querySelector("#result-score").textContent = "";
    renderResultsList([]);
    renderFinalBoard(state.leaderboard, null, state.answered);
    document.querySelector("#leave-room").hidden = false;
    showView("result-view");
  }
}

function setupEvents() {
  const bgInput = document.querySelector("#bg-image-input");
  const btnSelectBg = document.querySelector("#btn-select-bg");
  const btnClearBg = document.querySelector("#btn-clear-bg");
  const bgFileName = document.querySelector("#bg-file-name");
  const bgPreviewWrap = document.querySelector("#bg-preview-wrap");
  const bgPreview = document.querySelector("#bg-preview");

  btnSelectBg.addEventListener("click", () => bgInput.click());

  bgInput.addEventListener("change", () => {
    const file = bgInput.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast("La imagen debe pesar menos de 2 MB");
      bgInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      currentBgImage = e.target.result;
      bgFileName.textContent = file.name;
      bgPreview.src = currentBgImage;
      bgPreviewWrap.hidden = false;
      btnClearBg.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  btnClearBg.addEventListener("click", () => {
    currentBgImage = "";
    bgInput.value = "";
    bgFileName.textContent = "Ninguna imagen seleccionada";
    bgPreviewWrap.hidden = true;
    btnClearBg.hidden = true;
    bgPreview.src = "";
  });

  document.querySelector("#show-create").addEventListener("click", () => showView("create-view"));
  document.querySelector("#show-join").addEventListener("click", () => showView("join-view"));
  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.go));
  });

  document.querySelectorAll('input[name="activity-type"]').forEach((input) => {
    input.addEventListener("change", () => setTypeUI(input.value));
  });

  document.querySelector("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorElement = document.querySelector("#create-error");
    errorElement.textContent = "";

    saveCurrentFormToActiveQuestion();
    let payload;
    if (quizQuestions.length > 1) {
      payload = { activities: quizQuestions.map(activityObjectFromData) };
    } else {
      payload = activityObjectFromData(quizQuestions[0]);
    }

    const result = await emitWithAck("host:create", payload);

    if (result?.error) {
      errorElement.textContent = result.error;
      playTone("error");
      return;
    }
    hostToken = result.hostToken;
    saveTokens();
    renderHost(result.room);
    showView("host-view");
    showToast("Sala creada. Comparte el código o el QR.");
  });

  document.querySelector("#btn-save-template")?.addEventListener("click", saveCustomTemplate);
  document.querySelector("#btn-export-json")?.addEventListener("click", exportQuizJSON);
  document.querySelector("#import-json-input")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importQuizJSON(file);
    e.target.value = "";
  });

  document.querySelector("#next-activity")?.addEventListener("click", () => socket.emit("host:nextActivity"));
  document.querySelector("#export-csv")?.addEventListener("click", () => exportRoomToCSV(lastHostRoom));

  document.querySelector("#copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.querySelector("#share-link").textContent);
      showToast("Enlace copiado");
    } catch {
      showToast("No se pudo copiar. Puedes seleccionar y copiar el enlace.");
    }
  });

  document.querySelector("#start-activity").addEventListener("click", () => socket.emit("host:start"));
  document.querySelector("#end-activity").addEventListener("click", () => socket.emit("host:end"));
  document.querySelector("#reset-activity").addEventListener("click", () => socket.emit("host:reset"));
  document.querySelector("#close-room").addEventListener("click", () => {
    socket.emit("host:close");
    hostToken = "";
    sessionStorage.removeItem("limlimclap:host-token");
    showToast("Sala cerrada");
    showView("home-view");
  });

  document.querySelector("#projector-toggle").addEventListener("click", (event) => {
    const on = document.body.classList.toggle("projector");
    event.currentTarget.setAttribute("aria-pressed", String(on));
    showToast(on ? "Modo proyector activado" : "Modo proyector desactivado");
  });

  document.querySelector("#join-code").addEventListener("input", (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  document.querySelector("#join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorElement = document.querySelector("#join-error");
    errorElement.textContent = "";

    const nameInput = document.querySelector("#join-name").value.trim();
    const payload = {
      code: document.querySelector("#join-code").value,
      name: nameInput,
      token: participantToken,
    };

    const result = await emitWithAck("participant:join", payload);
    if (result?.error) {
      if (payload.token) clearParticipantToken();
      errorElement.textContent = result.error;
      playTone("error");
      return;
    }
    participantName = result.name || nameInput;
    participantToken = result.token;
    saveTokens();
    applyParticipantState(result);
  });

  document.querySelector("#submit-answer").addEventListener("click", async () => {
    const errorElement = document.querySelector("#game-error");
    errorElement.textContent = "";
    const answer = getAnswer();
    if (!answer) {
      errorElement.textContent = "Coloca todos los elementos antes de enviar.";
      playTone("error");
      return;
    }
    const result = await emitWithAck("participant:submit", { answer });
    if (result?.error) {
      errorElement.textContent = result.error;
      playTone("error");
      return;
    }
    showResult(result.score, result.results, { ended: false });
  });

  document.querySelector("#leave-room").addEventListener("click", () => {
    clearParticipantToken();
    showView("home-view");
  });

  document.querySelector("#sound-toggle").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("limlimclap:sound", soundEnabled ? "1" : "0");
    updateSoundButton();
    showToast(soundEnabled ? "Sonido activado" : "Sonido desactivado");
  });

  setupReactions();

  socket.on("room:reaction", ({ emoji }) => {
    spawnFloatingEmoji(emoji);
  });

  socket.on("room:update", (room) => {
    if (room.code === currentCode && document.querySelector("#host-view").classList.contains("active")) {
      renderHost(room);
    }
  });

  socket.on("room:state", (state) => {
    if (state.code === currentCode || !currentCode) applyParticipantState(state);
  });

  socket.on("room:closed", () => {
    stopTicker();
    showToast("El anfitrión cerró esta actividad");
    clearParticipantToken();
    showView("home-view");
  });

  socket.on("room:kicked", () => {
    stopTicker();
    showToast("El anfitrión te retiró de la sala");
    clearParticipantToken();
    showView("join-view");
  });
}

async function attemptHostRestore() {
  if (!hostToken) return false;
  const code = new URLSearchParams(window.location.search).get("host");
  if (!code) return false;
  const result = await emitWithAck("host:rejoin", { code, hostToken });
  if (result?.error) {
    hostToken = "";
    sessionStorage.removeItem("limlimclap:host-token");
    return false;
  }
  renderHost(result.room);
  showView("host-view");
  return true;
}

function initFromUrl() {
  const inviteCode = new URLSearchParams(window.location.search).get("join");
  if (inviteCode) {
    document.querySelector("#join-code").value = inviteCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    showView("join-view");
  }
}

initDarkMode();
renderTemplates();
renderCustomTemplates();
renderQuestionTabs();
setTypeUI("zones");
applyTheme("green");
setupEvents();
updateSoundButton();
initFromUrl();
attemptHostRestore();

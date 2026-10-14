const express = require("express");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });
const rooms = new Map();
const createLog = new Map();

const PORT = process.env.PORT || 3000;
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/$/, "");
const MOUNTS = BASE_PATH ? ["", BASE_PATH] : [""];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const THEMES = ["green", "blue", "coral", "violet"];
const MAX_ROOMS = 500;
const MAX_PARTICIPANTS = 300;
const CREATES_PER_HOUR = 20;
const HOST_GRACE_MS = 90 * 1000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

if (process.env.TRUST_PROXY) app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ws: wss:; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get(/^\/qr\/([A-Z0-9]{6})\.svg$/, async (req, res) => {
  const code = req.params[0];
  if (!rooms.has(code)) return res.status(404).end();
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  const basePath = (process.env.BASE_PATH || "").replace(/\/+$/, "");
  const link = `${protocol}://${req.get("host")}${basePath}/?join=${code}`;
  const svg = await QRCode.toString(link, { type: "svg", margin: 1 });
  res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
});

const PUBLIC_DIR = path.join(__dirname, "public");

async function serveIndex(request, response, next) {
  try {
    let html = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
    html = html
      .replace('content="/og-image.svg"', 'content="' + BASE_PATH + '/og-image.svg"')
      .replace('href="/favicon.svg"', 'href="' + BASE_PATH + '/favicon.svg"')
      .replace('href="/styles.css"', 'href="' + BASE_PATH + '/styles.css"')
      .replace('src="/socket.io/socket.io.js"', 'src="' + BASE_PATH + '/socket.io/socket.io.js"')
      .replace('src="/app.js"', 'src="' + BASE_PATH + '/app.js"')
      .replace('href="/"', 'href="' + (BASE_PATH || "/") + '"')
      .replace("<body>", "<body>\n    <script>window.__LIMLIM_BASE__=" + JSON.stringify(BASE_PATH) + ";</script>");
    response.type("html").send(html);
  } catch (error) {
    next(error);
  }
}

for (const mount of MOUNTS) {
  const rootPath = mount || "/";
  app.get(rootPath, serveIndex);
  if (mount) app.get(mount + "/", serveIndex);
  app.use(rootPath, express.static(PUBLIC_DIR));
}


function cleanText(value, maxLength = 120) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanImage(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("data:image/") && trimmed.length <= 1.5e6) return trimmed;
  if (/^https?:\/\//i.test(trimmed) && trimmed.length <= 500) return trimmed;
  return "";
}

function validateActivity(input) {
  const type = input?.type;
  const prompt = cleanText(input?.prompt, 240);
  if (!prompt) return { error: "Escribe una consigna para la actividad." };

  const timeLimit = input?.timeLimit ?? 0;
  if (!Number.isInteger(timeLimit) || (timeLimit !== 0 && (timeLimit < 10 || timeLimit > 3600))) {
    return { error: "El tiempo límite debe estar entre 10 segundos y 60 minutos." };
  }
  const theme = THEMES.includes(input?.theme) ? input.theme : "green";
  const bgImage = cleanImage(input?.bgImage);
  const base = { type, prompt, timeLimit, theme, ...(bgImage ? { bgImage } : {}) };

  if (type === "zones") {
    if (!Array.isArray(input.pairs) || input.pairs.length < 2 || input.pairs.length > 20) {
      return { error: "Añade entre 2 y 20 elementos con su zona correcta." };
    }
    const pairs = input.pairs.map((pair) => {
      const label = cleanText(pair?.label, 80);
      const target = cleanText(pair?.target, 80);
      const image = cleanImage(pair?.image);
      return {
        label,
        target,
        ...(image ? { image } : {}),
      };
    });
    if (pairs.some((pair) => !pair.label || !pair.target)) {
      return { error: "Cada elemento y cada zona deben tener un nombre." };
    }
    if (new Set(pairs.map((pair) => pair.label.toLowerCase())).size !== pairs.length) {
      return { error: "Los nombres de los elementos deben ser únicos." };
    }
    return { activity: { ...base, pairs } };
  }

  if (type === "sequence") {
    if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > 20) {
      return { error: "Añade entre 2 y 20 elementos para ordenar." };
    }
    const items = input.items.map((item) => {
      if (typeof item === "object" && item !== null) {
        const text = cleanText(item.text || item.label, 80);
        const image = cleanImage(item.image);
        return { text, ...(image ? { image } : {}) };
      }
      return { text: cleanText(item, 80) };
    });
    if (items.some((item) => !item.text)) return { error: "No dejes elementos vacíos." };
    if (new Set(items.map((item) => item.text.toLowerCase())).size !== items.length) {
      return { error: "Los nombres de los elementos deben ser únicos." };
    }
    return { activity: { ...base, items } };
  }

  return { error: "Elige un tipo de actividad válido." };
}

function validateActivities(input) {
  if (Array.isArray(input?.activities) && input.activities.length > 0) {
    if (input.activities.length > 15) {
      return { error: "Máximo 15 actividades por sala." };
    }
    const validated = [];
    for (let index = 0; index < input.activities.length; index += 1) {
      const res = validateActivity(input.activities[index]);
      if (res.error) return { error: `Actividad ${index + 1}: ${res.error}` };
      validated.push(res.activity);
    }
    return { activities: validated };
  }
  const single = validateActivity(input);
  if (single.error) return single;
  return { activities: [single.activity] };
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const otherIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[otherIndex]] = [result[otherIndex], result[index]];
  }
  return result;
}

function publicActivity(activity) {
  const base = {
    type: activity.type,
    prompt: activity.prompt,
    theme: activity.theme,
    ...(activity.bgImage ? { bgImage: activity.bgImage } : {}),
  };
  if (activity.type === "zones") {
    return {
      ...base,
      labels: shuffled(activity.pairs.map((pair) => ({ label: pair.label, image: pair.image }))),
      targets: shuffled([...new Set(activity.pairs.map((pair) => pair.target))]),
    };
  }
  let items = shuffled(activity.items);
  while (items.length > 1 && items.every((item, index) => (item.text || item) === (activity.items[index].text || activity.items[index]))) {
    items = shuffled(activity.items);
  }
  return { ...base, items };
}

function answerScore(activity, answer) {
  if (activity.type === "zones") {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
    const labels = activity.pairs.map((pair) => pair.label);
    if (
      Object.keys(answer).length !== labels.length ||
      labels.some((label) => !Object.hasOwn(answer, label) || typeof answer[label] !== "string")
    ) {
      return null;
    }
    const results = activity.pairs.map((pair) => ({
      name: pair.label,
      chosen: answer[pair.label],
      expected: pair.target,
      ok: answer[pair.label] === pair.target,
    }));
    return { correct: results.filter((result) => result.ok).length, total: results.length, results };
  }

  const itemTexts = activity.items.map((it) => it.text || it);
  if (
    !Array.isArray(answer) ||
    answer.length !== itemTexts.length ||
    answer.some((item) => typeof item !== "string") ||
    new Set(answer).size !== itemTexts.length ||
    answer.some((item) => !itemTexts.includes(item))
  ) {
    return null;
  }
  const results = itemTexts.map((expected, index) => ({
    name: `Posición ${index + 1}`,
    chosen: answer[index],
    ok: answer[index] === expected,
  }));
  return { correct: results.filter((result) => result.ok).length, total: results.length, results };
}

function calculateScoreWithBonus(score, { startedAt, submittedAt, timeLimit } = {}) {
  const elapsedMs = Math.max(0, (submittedAt || Date.now()) - (startedAt || submittedAt || Date.now()));
  const basePoints = score.correct * 1000;
  let speedBonus = 0;
  if (score.correct > 0) {
    if (timeLimit && timeLimit > 0) {
      const totalMs = timeLimit * 1000;
      const remaining = Math.max(0, totalMs - elapsedMs);
      speedBonus = Math.round((remaining / totalMs) * 500 * (score.correct / score.total));
    } else {
      const remaining = Math.max(0, 60000 - elapsedMs);
      speedBonus = Math.round((remaining / 60000) * 500 * (score.correct / score.total));
    }
  }
  const points = basePoints + speedBonus;
  return {
    ...score,
    basePoints,
    speedBonus,
    points,
    timeSeconds: Math.round(elapsedMs / 100) / 10,
  };
}

function remainingMs(room) {
  return room.endsAt ? Math.max(0, room.endsAt - Date.now()) : null;
}

function participantPoints(participant) {
  if (typeof participant.totalPoints === "number" && participant.totalPoints > 0) {
    return participant.totalPoints;
  }
  return participant.score?.points || 0;
}

function participantCorrect(participant) {
  if (typeof participant.totalCorrect === "number" && participant.totalCorrect > 0) {
    return participant.totalCorrect;
  }
  return participant.score?.correct || 0;
}

function ranking(room) {
  return [...room.participants.values()]
    .filter((participant) => participant.score || (participant.totalPoints && participant.totalPoints > 0))
    .sort((a, b) => {
      const diffPoints = participantPoints(b) - participantPoints(a);
      if (diffPoints !== 0) return diffPoints;
      const diffCorrect = participantCorrect(b) - participantCorrect(a);
      if (diffCorrect !== 0) return diffCorrect;
      return (a.submittedAt || 0) - (b.submittedAt || 0);
    });
}

function roomSummary(room) {
  const answered = ranking(room);
  const names = room.activity.type === "zones"
    ? room.activity.pairs.map((pair) => pair.label)
    : room.activity.items.map((item, index) => `${index + 1}. ${item.text || item}`);
  return {
    code: room.code,
    prompt: room.activity.prompt,
    type: room.activity.type,
    theme: room.activity.theme,
    ...(room.activity.bgImage ? { bgImage: room.activity.bgImage } : {}),
    status: room.status,
    activityIndex: room.activityIndex || 0,
    totalActivities: room.activities ? room.activities.length : 1,
    isLastActivity: !room.activities || room.activityIndex >= room.activities.length - 1,
    timeLimit: room.activity.timeLimit,
    remainingMs: remainingMs(room),
    participants: [...room.participants.values()].map((participant) => ({
      id: participant.id,
      name: participant.name,
      connected: participant.connected,
      submitted: Boolean(participant.score),
      score: participant.score && {
        correct: participant.score.correct,
        total: participant.score.total,
        points: participant.score.points,
        speedBonus: participant.score.speedBonus,
        timeSeconds: participant.score.timeSeconds,
      },
      totalPoints: participant.totalPoints || participant.score?.points || 0,
      totalCorrect: participant.totalCorrect || participant.score?.correct || 0,
      totalPossible: participant.totalPossible || participant.score?.total || 0,
    })),
    stats: names.map((name, index) => ({
      name,
      correct: answered.filter((participant) => participant.score?.results?.[index]?.ok).length,
      answered: answered.filter((participant) => participant.score).length,
    })),
  };
}

function participantState(room, participant) {
  const state = {
    code: room.code,
    theme: room.activity.theme,
    status: room.status,
    remainingMs: remainingMs(room),
    name: participant.name,
    activityIndex: room.activityIndex || 0,
    totalActivities: room.activities ? room.activities.length : 1,
    isLastActivity: !room.activities || room.activityIndex >= room.activities.length - 1,
    totalPoints: participant.totalPoints || participant.score?.points || 0,
    totalCorrect: participant.totalCorrect || participant.score?.correct || 0,
    totalPossible: participant.totalPossible || participant.score?.total || 0,
  };
  if (participant.score) {
    state.score = {
      correct: participant.score.correct,
      total: participant.score.total,
      points: participant.score.points,
      speedBonus: participant.score.speedBonus,
      timeSeconds: participant.score.timeSeconds,
    };
    state.results = participant.score.results;
  }
  if (room.status === "live" && !participant.score) state.activity = publicActivity(room.activity);
  if (room.status === "ended") {
    const ranked = ranking(room);
    state.leaderboard = ranked.slice(0, 5).map((entry) => ({
      name: entry.name,
      correct: entry.totalCorrect || entry.score?.correct || 0,
      total: entry.totalPossible || entry.score?.total || 0,
      points: entry.totalPoints || entry.score?.points || 0,
    }));
    state.rank = (participant.score || participant.totalPoints > 0) ? ranked.indexOf(participant) + 1 : null;
    state.answered = ranked.length;
  }
  return state;
}

function notifyHost(room) {
  io.to(room.hostSocketId).emit("room:update", roomSummary(room));
}

function pushState(room) {
  for (const participant of room.participants.values()) {
    if (participant.connected) io.to(participant.socketId).emit("room:state", participantState(room, participant));
  }
  notifyHost(room);
}

function clearTimers(room) {
  clearTimeout(room.timer);
  clearTimeout(room.hostGrace);
  room.timer = null;
  room.hostGrace = null;
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimers(room);
  io.to(code).emit("room:closed");
  rooms.delete(code);
}

function endRoom(room) {
  if (room.status !== "live") return;
  clearTimeout(room.timer);
  room.timer = null;
  room.endsAt = null;
  room.status = "ended";
  pushState(room);
}

function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= CREATES_PER_HOUR) return false;
  recent.push(now);
  createLog.set(ip, recent);
  return true;
}

function clientIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  return (process.env.TRUST_PROXY && forwarded?.split(",")[0].trim()) || socket.handshake.address;
}

function hostRoom(socket) {
  const room = rooms.get(socket.data.hostCode);
  return room && room.hostSocketId === socket.id ? room : null;
}

io.on("connection", (socket) => {
  socket.on("host:create", (input, acknowledge) => {
    const result = validateActivities(input);
    if (result.error) return acknowledge?.({ error: result.error });
    if (rooms.size >= MAX_ROOMS || !allowCreate(clientIp(socket))) {
      return acknowledge?.({ error: "Se alcanzó el límite de salas. Inténtalo de nuevo más tarde." });
    }
    if (socket.data.hostCode) closeRoom(socket.data.hostCode);

    const room = {
      code: makeRoomCode(),
      hostToken: crypto.randomUUID(),
      hostSocketId: socket.id,
      activities: result.activities,
      activityIndex: 0,
      activity: result.activities[0],
      participants: new Map(),
      kicked: new Set(),
      status: "lobby",
      startedAt: null,
      endsAt: null,
      timer: null,
      hostGrace: null,
      createdAt: Date.now(),
      nextId: 1,
    };
    rooms.set(room.code, room);
    socket.data.hostCode = room.code;
    socket.join(room.code);
    acknowledge?.({ room: roomSummary(room), hostToken: room.hostToken });
  });

  socket.on("host:rejoin", (input, acknowledge) => {
    const room = rooms.get(cleanText(input?.code, 6).toUpperCase());
    if (!room || room.hostToken !== input?.hostToken) return acknowledge?.({ error: "La sala ya no existe." });
    clearTimeout(room.hostGrace);
    room.hostGrace = null;
    room.hostSocketId = socket.id;
    socket.data.hostCode = room.code;
    socket.join(room.code);
    acknowledge?.({ room: roomSummary(room) });
  });

  socket.on("host:start", () => {
    const room = hostRoom(socket);
    if (!room || room.status !== "lobby") return;
    room.status = "live";
    room.startedAt = Date.now();
    if (room.activity.timeLimit) {
      room.endsAt = Date.now() + room.activity.timeLimit * 1000;
      room.timer = setTimeout(() => endRoom(room), room.activity.timeLimit * 1000);
      room.timer.unref();
    }
    pushState(room);
  });

  socket.on("host:nextActivity", () => {
    const room = hostRoom(socket);
    if (!room || !room.activities) return;
    if (room.activityIndex + 1 >= room.activities.length) return;

    clearTimers(room);
    room.activityIndex += 1;
    room.activity = room.activities[room.activityIndex];
    room.status = "live";
    room.startedAt = Date.now();
    if (room.activity.timeLimit) {
      room.endsAt = Date.now() + room.activity.timeLimit * 1000;
      room.timer = setTimeout(() => endRoom(room), room.activity.timeLimit * 1000);
      room.timer.unref();
    } else {
      room.endsAt = null;
    }
    for (const participant of room.participants.values()) {
      participant.score = null;
      participant.submittedAt = null;
    }
    pushState(room);
  });

  socket.on("host:end", () => {
    const room = hostRoom(socket);
    if (room) endRoom(room);
  });

  socket.on("host:reset", () => {
    const room = hostRoom(socket);
    if (!room) return;
    clearTimeout(room.timer);
    room.timer = null;
    room.endsAt = null;
    room.startedAt = null;
    room.activityIndex = 0;
    room.activity = room.activities ? room.activities[0] : room.activity;
    room.status = "lobby";
    for (const participant of room.participants.values()) {
      participant.score = null;
      participant.submittedAt = null;
      participant.scoresByActivity = [];
      participant.totalPoints = 0;
      participant.totalCorrect = 0;
      participant.totalPossible = 0;
    }
    pushState(room);
  });

  socket.on("host:kick", (input) => {
    const room = hostRoom(socket);
    if (!room) return;
    for (const [token, participant] of room.participants) {
      if (participant.id === input?.id) {
        room.participants.delete(token);
        room.kicked.add(token);
        io.to(participant.socketId).emit("room:kicked");
        io.sockets.sockets.get(participant.socketId)?.leave(room.code);
      }
    }
    notifyHost(room);
  });

  socket.on("host:close", () => {
    const room = hostRoom(socket);
    if (room) closeRoom(room.code);
  });

  socket.on("room:react", (input) => {
    const code = socket.data.code || socket.data.hostCode;
    const room = rooms.get(code);
    if (!room) return;
    const emoji = cleanText(input?.emoji, 8);
    if (!emoji) return;
    const now = Date.now();
    if (socket.data.lastReaction && now - socket.data.lastReaction < 200) return;
    socket.data.lastReaction = now;
    io.to(room.code).emit("room:reaction", { emoji, id: crypto.randomUUID() });
  });

  socket.on("participant:join", (input, acknowledge) => {
    const room = rooms.get(cleanText(input?.code, 6).toUpperCase());
    if (!room) return acknowledge?.({ error: "No encontramos una actividad abierta con ese código." });
    const token = cleanText(input?.token, 64);
    if (room.kicked.has(token)) return acknowledge?.({ error: "El anfitrión te retiró de esta sala." });

    let participant = token && room.participants.get(token);
    if (participant) {
      participant.socketId = socket.id;
      participant.connected = true;
    } else {
      const name = cleanText(input?.name, 40);
      if (!name) return acknowledge?.({ error: "Escribe tu nombre para entrar." });
      if (room.participants.size >= MAX_PARTICIPANTS) return acknowledge?.({ error: "La sala está llena." });
      participant = {
        id: String(room.nextId++),
        token: crypto.randomUUID(),
        name,
        socketId: socket.id,
        connected: true,
        score: null,
        submittedAt: null,
        scoresByActivity: [],
        totalPoints: 0,
        totalCorrect: 0,
        totalPossible: 0,
      };
      room.participants.set(participant.token, participant);
    }
    socket.data.code = room.code;
    socket.data.token = participant.token;
    socket.join(room.code);
    acknowledge?.({ ...participantState(room, participant), token: participant.token });
    notifyHost(room);
  });

  socket.on("participant:submit", (input, acknowledge) => {
    const room = rooms.get(socket.data.code);
    const participant = room?.participants.get(socket.data.token);
    if (!room || !participant) {
      return acknowledge?.({ error: "La actividad ya no está disponible. Vuelve a entrar con un código activo." });
    }
    if (room.status !== "live") return acknowledge?.({ error: "La actividad no está recibiendo respuestas." });
    if (participant.score) return acknowledge?.({ error: "Ya enviaste tu respuesta." });
    const baseScore = answerScore(room.activity, input?.answer);
    if (!baseScore) return acknowledge?.({ error: "Completa todos los elementos antes de enviar." });

    const score = calculateScoreWithBonus(baseScore, {
      startedAt: room.startedAt,
      submittedAt: Date.now(),
      timeLimit: room.activity.timeLimit,
    });

    participant.score = score;
    participant.submittedAt = Date.now();
    if (!participant.scoresByActivity) participant.scoresByActivity = [];
    participant.scoresByActivity[room.activityIndex || 0] = score;

    participant.totalPoints = participant.scoresByActivity.reduce((sum, s) => sum + (s?.points || 0), 0);
    participant.totalCorrect = participant.scoresByActivity.reduce((sum, s) => sum + (s?.correct || 0), 0);
    participant.totalPossible = participant.scoresByActivity.reduce((sum, s) => sum + (s?.total || 0), 0);

    acknowledge?.({
      score: {
        correct: score.correct,
        total: score.total,
        points: score.points,
        speedBonus: score.speedBonus,
        timeSeconds: score.timeSeconds,
      },
      totalPoints: participant.totalPoints,
      results: score.results,
    });
    notifyHost(room);
  });

  socket.on("disconnect", () => {
    const { hostCode, code, token } = socket.data;
    const hosted = rooms.get(hostCode);
    if (hosted && hosted.hostSocketId === socket.id) {
      hosted.hostGrace = setTimeout(() => closeRoom(hosted.code), HOST_GRACE_MS);
      hosted.hostGrace.unref();
    }
    const room = rooms.get(code);
    const participant = room?.participants.get(token);
    if (participant && participant.socketId === socket.id) {
      participant.connected = false;
      notifyHost(room);
    }
  });
});

if (require.main === module) {
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > ROOM_TTL_MS) closeRoom(code);
    for (const [ip, times] of createLog) {
      if (times.every((time) => now - time > 60 * 60 * 1000)) createLog.delete(ip);
    }
  }, 10 * 60 * 1000).unref();
  const HOST = process.env.HOST || "127.0.0.1";
  server.listen(PORT, HOST, () => {
    console.log(`Limlimclap disponible en http://${HOST}:${PORT}`);
  });
}

module.exports = { answerScore, validateActivity, validateActivities, calculateScoreWithBonus, server, io, rooms };

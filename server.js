const express = require("express");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
const rooms = new Map();
const createLog = new Map();

const PORT = process.env.PORT || 3000;
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
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get(/^\/qr\/([A-Z0-9]{6})\.svg$/, async (req, res) => {
  const code = req.params[0];
  if (!rooms.has(code)) return res.status(404).end();
  const link = `${req.protocol}://${req.get("host")}/?join=${code}`;
  const svg = await QRCode.toString(link, { type: "svg", margin: 1 });
  res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
});

app.use(express.static(path.join(__dirname, "public")));

function cleanText(value, maxLength = 120) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
  const base = { type, prompt, timeLimit, theme };

  if (type === "zones") {
    if (!Array.isArray(input.pairs) || input.pairs.length < 2 || input.pairs.length > 20) {
      return { error: "Añade entre 2 y 20 elementos con su zona correcta." };
    }
    const pairs = input.pairs.map((pair) => ({
      label: cleanText(pair?.label, 80),
      target: cleanText(pair?.target, 80),
    }));
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
    const items = input.items.map((item) => cleanText(item, 80));
    if (items.some((item) => !item)) return { error: "No dejes elementos vacíos." };
    if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
      return { error: "Los nombres de los elementos deben ser únicos." };
    }
    return { activity: { ...base, items } };
  }

  return { error: "Elige un tipo de actividad válido." };
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
  const base = { type: activity.type, prompt: activity.prompt, theme: activity.theme };
  if (activity.type === "zones") {
    return {
      ...base,
      labels: shuffled(activity.pairs.map((pair) => pair.label)),
      targets: shuffled([...new Set(activity.pairs.map((pair) => pair.target))]),
    };
  }
  let items = shuffled(activity.items);
  while (items.length > 1 && items.every((item, index) => item === activity.items[index])) {
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

  if (
    !Array.isArray(answer) ||
    answer.length !== activity.items.length ||
    answer.some((item) => typeof item !== "string") ||
    new Set(answer).size !== activity.items.length ||
    answer.some((item) => !activity.items.includes(item))
  ) {
    return null;
  }
  const results = activity.items.map((expected, index) => ({
    name: `Posición ${index + 1}`,
    chosen: answer[index],
    expected,
    ok: answer[index] === expected,
  }));
  return { correct: results.filter((result) => result.ok).length, total: results.length, results };
}

function remainingMs(room) {
  return room.endsAt ? Math.max(0, room.endsAt - Date.now()) : null;
}

function ranking(room) {
  return [...room.participants.values()]
    .filter((participant) => participant.score)
    .sort((a, b) => b.score.correct - a.score.correct || a.submittedAt - b.submittedAt);
}

function roomSummary(room) {
  const answered = ranking(room);
  const names = room.activity.type === "zones"
    ? room.activity.pairs.map((pair) => pair.label)
    : room.activity.items.map((item, index) => `${index + 1}. ${item}`);
  return {
    code: room.code,
    prompt: room.activity.prompt,
    type: room.activity.type,
    theme: room.activity.theme,
    status: room.status,
    timeLimit: room.activity.timeLimit,
    remainingMs: remainingMs(room),
    participants: [...room.participants.values()].map((participant) => ({
      id: participant.id,
      name: participant.name,
      connected: participant.connected,
      submitted: Boolean(participant.score),
      score: participant.score && { correct: participant.score.correct, total: participant.score.total },
    })),
    stats: names.map((name, index) => ({
      name,
      correct: answered.filter((participant) => participant.score.results[index].ok).length,
      answered: answered.length,
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
  };
  if (participant.score) {
    state.score = { correct: participant.score.correct, total: participant.score.total };
    state.results = participant.score.results;
  }
  if (room.status === "live" && !participant.score) state.activity = publicActivity(room.activity);
  if (room.status === "ended") {
    const ranked = ranking(room);
    state.leaderboard = ranked.slice(0, 5).map((entry) => ({
      name: entry.name,
      correct: entry.score.correct,
      total: entry.score.total,
    }));
    state.rank = participant.score ? ranked.indexOf(participant) + 1 : null;
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
    const result = validateActivity(input);
    if (result.error) return acknowledge?.({ error: result.error });
    if (rooms.size >= MAX_ROOMS || !allowCreate(clientIp(socket))) {
      return acknowledge?.({ error: "Se alcanzó el límite de salas. Inténtalo de nuevo más tarde." });
    }
    if (socket.data.hostCode) closeRoom(socket.data.hostCode);

    const room = {
      code: makeRoomCode(),
      hostToken: crypto.randomUUID(),
      hostSocketId: socket.id,
      activity: result.activity,
      participants: new Map(),
      kicked: new Set(),
      status: "lobby",
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
    if (room.activity.timeLimit) {
      room.endsAt = Date.now() + room.activity.timeLimit * 1000;
      room.timer = setTimeout(() => endRoom(room), room.activity.timeLimit * 1000);
      room.timer.unref();
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
    room.status = "lobby";
    for (const participant of room.participants.values()) {
      participant.score = null;
      participant.submittedAt = null;
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
    const score = answerScore(room.activity, input?.answer);
    if (!score) return acknowledge?.({ error: "Completa todos los elementos antes de enviar." });

    participant.score = score;
    participant.submittedAt = Date.now();
    acknowledge?.({ score: { correct: score.correct, total: score.total }, results: score.results });
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
  server.listen(PORT, () => {
    console.log(`Limlimclap disponible en http://localhost:${PORT}`);
  });
}

module.exports = { answerScore, validateActivity, server, io, rooms };

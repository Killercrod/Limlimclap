const express = require("express");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const rooms = new Map();
const PORT = process.env.PORT || 3000;
// Prefijo bajo el que se publica la app. Vacio cuando corre sola (localhost:
//3000) y "/limlimclap" cuando se sirve desde un camino del túnel. Todo lo que
// el navegador pide tiene que llevar el prefijo: si no, /app.js o
// /socket.io/ se irían a la aplicación que ocupe la raíz del dominio.
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/$/, "");
// Socket.IO sirve su cliente en la ruta que se le configure, no en un prefijo
// aparte. Con BASE_PATH hay que alinearla o el navegador pediria el cliente en
// /limlimclap/socket.io/ y recibiria 404, dejando la app sin JS. El proxy quita
// solo el prefijo del dominio: /limlimclap/socket.io/ llega aqui como
// /socket.io/.
const io = new Server(server, { path: `${BASE_PATH}/socket.io/` });
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// El HTML se lee y se reenvia ya con el prefijo puesto, en lugar de tener
// rutas absolutas que apuntan a otro sitio. sendFile se usaria sin callback para
// no tener que pisar sus headers.
app.get(`${BASE_PATH}/`, (request, response, next) => {
  fs.readFile(path.join(__dirname, "public", "index.html"), (error, data) => {
    if (error) return next(error);
    response.type("html").send(
      data
        .toString()
        .replaceAll("__BASE__", BASE_PATH || "")
        // El cliente lee el prefijo de aqui para apuntar el socket.
        .replace(
          "<body>",
          `<body>\n    <script>window.__LIMLIM_BASE__=${JSON.stringify(BASE_PATH)};</script>`,
        )
        // El enlace del logo apunta a "/", que fuera del prefijo lleva a la raiz
        // del dominio: hay que fijarlo completo.
        .replace('href="/"', `href="${BASE_PATH || "/"}"`),
    );
  });
});

app.use(BASE_PATH || "/", express.static(path.join(__dirname, "public")));

function cleanText(value, maxLength = 120) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateActivity(input) {
  const type = input?.type;
  const prompt = cleanText(input?.prompt, 240);
  if (!prompt) return { error: "Escribe una consigna para la actividad." };

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
    return { activity: { type, prompt, pairs } };
  }

  if (type === "sequence") {
    if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > 20) {
      return { error: "Añade entre 2 y 20 elementos para ordenar." };
    }
    const items = input.items.map((item) => cleanText(item, 80));
    if (items.some((item) => !item)) {
      return { error: "No dejes elementos vacíos." };
    }
    if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
      return { error: "Los nombres de los elementos deben ser únicos." };
    }
    return { activity: { type, prompt, items } };
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

function roomSummary(room) {
  return {
    code: room.code,
    prompt: room.activity.prompt,
    type: room.activity.type,
    participants: [...room.participants.values()].map((participant) => ({
      name: participant.name,
      connected: participant.connected,
      submitted: participant.answer !== null,
      score: participant.score,
    })),
  };
}

function answerScore(activity, answer) {
  if (activity.type === "zones") {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
    const labels = activity.pairs.map((pair) => pair.label);
    if (Object.keys(answer).length !== labels.length || labels.some((label) => typeof answer[label] !== "string")) {
      return null;
    }
    const correct = activity.pairs.filter((pair) => answer[pair.label] === pair.target).length;
    return { correct, total: labels.length };
  }

  if (!Array.isArray(answer) || answer.length !== activity.items.length ||
      answer.some((item) => typeof item !== "string") ||
      new Set(answer).size !== activity.items.length ||
      answer.some((item) => !activity.items.includes(item))) {
    return null;
  }
  const correct = answer.filter((item, index) => item === activity.items[index]).length;
  return { correct, total: activity.items.length };
}

io.on("connection", (socket) => {
  socket.on("host:create", (input, acknowledge) => {
    const result = validateActivity(input);
    if (result.error) return acknowledge?.({ error: result.error });

    const room = {
      code: makeRoomCode(),
      hostSocketId: socket.id,
      activity: result.activity,
      participants: new Map(),
      open: true,
    };
    rooms.set(room.code, room);
    socket.join(room.code);
    acknowledge?.({ room: roomSummary(room), activity: room.activity });
  });

  socket.on("participant:join", (input, acknowledge) => {
    const normalizedCode = cleanText(input?.code, 6).toUpperCase();
    const participantName = cleanText(input?.name, 40);
    const room = rooms.get(normalizedCode);
    if (!room || !room.open) return acknowledge?.({ error: "No encontramos una actividad abierta con ese código." });
    if (!participantName) return acknowledge?.({ error: "Escribe tu nombre para entrar." });

    room.participants.set(socket.id, { name: participantName, connected: true, answer: null, score: null });
    socket.join(room.code);
    acknowledge?.({
      room: roomSummary(room),
      activity: {
        type: room.activity.type,
        prompt: room.activity.prompt,
        ...(room.activity.type === "zones"
          ? { labels: room.activity.pairs.map((pair) => pair.label), targets: [...new Set(room.activity.pairs.map((pair) => pair.target))] }
          : { items: shuffled(room.activity.items) }),
      },
    });
    io.to(room.hostSocketId).emit("room:update", roomSummary(room));
  });

  socket.on("participant:submit", (input, acknowledge) => {
    const room = rooms.get(cleanText(input?.code, 6).toUpperCase());
    const participant = room?.participants.get(socket.id);
    if (!room || !room.open || !participant) {
      return acknowledge?.({ error: "La actividad ya no está disponible. Vuelve a entrar con un código activo." });
    }
    const score = answerScore(room.activity, input?.answer);
    if (!score) return acknowledge?.({ error: "Completa todos los elementos antes de enviar." });

    participant.answer = input.answer;
    participant.score = score;
    acknowledge?.({ score });
    io.to(room.hostSocketId).emit("room:update", roomSummary(room));
    socket.emit("participant:submitted", { score });
  });

  socket.on("host:close", (input) => {
    const roomCode = cleanText(input?.code, 6).toUpperCase();
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;
    room.open = false;
    io.to(roomCode).emit("room:closed");
    rooms.delete(roomCode);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (room.hostSocketId === socket.id) {
        io.to(code).emit("room:closed");
        rooms.delete(code);
        continue;
      }
      const participant = room.participants.get(socket.id);
      if (participant) {
        participant.connected = false;
        io.to(room.hostSocketId).emit("room:update", roomSummary(room));
      }
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Limlimclap disponible en http://localhost:${PORT}`);
  });
}

module.exports = { answerScore, validateActivity };

const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
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
// Socket.IO se deja con su ruta por defecto (/socket.io/) a proposito, y es
// contraintuitivo: el tunel de Tailscale quita el prefijo antes de reenviar, asi
// que /limlimclap/socket.io/ llega a esta app como /socket.io/. Lo que el
// navegador pide lleva el prefijo (BASE_PATH) y lo que el servidor matchea no
// (path por defecto). Si se le pusiera el prefijo aqui, no habria coincidencia.
const io = new Server(server);
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Imagenes en disco, en /var/lib y no dentro del repo: sobreviven a un reinicio,
// asi que el borrador del host y las salas en curso ya no se quedan sin ellas.
// El directorio queda fuera de ProtectedHome=read-only, asi que el servicio
// necesita ReadWritePaths para poder escribir ahi.
const IMAGE_DIR = process.env.IMAGE_DIR || "/var/lib/limlimclap/imagenes";
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
// 40 imagenes por actividad es el tope que ve una ronda. El almacen completo
// tiene que ser bastante mas grande: con 8 MB de tope global quedaban cuatro
// imagenes en todo el servidor y a la quinta subida fallaba todo, que solo
// servia mientras las imagenes vivieran en memoria y se perdieran solas.
const IMAGE_MAX_PER_ACTIVITY = 40;
const IMAGE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
const IMAGE_MAX_COUNT = 2000;
const IMAGE_TTL_HOURS = 72;

const { createImageStore } = require("./image-store");
const images = createImageStore({
  dir: IMAGE_DIR,
  maxBytes: IMAGE_MAX_BYTES,
  maxCount: IMAGE_MAX_COUNT,
  maxTotalBytes: IMAGE_TOTAL_MAX_BYTES,
  ttlMs: IMAGE_TTL_HOURS * 60 * 60 * 1000,
});

// La app se monta en la raiz y en el prefijo, y no solo en uno de los dos:
// con el tunel de por medio el prefijo se pierde (/limlimclap/ llega como /) y
// al probar en local se usa el otro. BASE_PATH sigue sirviendo para lo que ve el
// navegador: los enlaces que genera el HTML.
const PUBLIC_DIR = path.join(__dirname, "public");
const MOUNTS = BASE_PATH ? ["", BASE_PATH] : [""];

// Version de los assets: cambia cuando cambia cualquiera de ellos. Se pone como
// query en los enlaces del HTML para que un navegador con la copia vieja no siga
// ejecutando el JS anterior despues de un despliegue.
const ASSETS = ["app.js", "items-editor.js", "styles.css"];
const ASSET_VERSION = crypto
  .createHash("sha1")
  .update(
    ASSETS.map((name) => {
      try {
        return fs.statSync(path.join(PUBLIC_DIR, name)).mtimeMs;
      } catch {
        return "0";
      }
    }).join(":"),
  )
  .digest("hex")
  .slice(0, 8);

function serveIndex(request, response, next) {
  fs.readFile(path.join(PUBLIC_DIR, "index.html"), (error, data) => {
    if (error) return next(error);
    response.type("html").send(
      data
        .toString()
        // La version va primero: todavia esta el marcador __BASE__ literal, que
        // es lo que permite distinguir los assets propios del resto.
        .replaceAll(
          /(__BASE__\/(?:app|items-editor)\.js|__BASE__\/styles\.css)"/g,
          '$1?v=' + ASSET_VERSION + '"',
        )
        .replaceAll("__BASE__", BASE_PATH)
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
}

// express.raw corta el cuerpo antes del handler cuando excede el limite, y por
// defecto responde con una pagina HTML. Se cambia por JSON para que el cliente
// pueda mostrar el motivo.
function uploadErrorHandler(error, request, response, next) {
  if (error?.type === "entity.too.large") {
    return response.status(413).json({
      error: `La imagen supera los ${IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
    });
  }
  return next(error);
}

for (const mount of MOUNTS) {
  app.get(`${mount}/`, serveIndex);
  app.use(mount || "/", express.static(PUBLIC_DIR));

  // Subida de imagen. Se manda el binario crudo (no base64 ni multipart) para
  // no agregar dependencias ni gastar un tercio más de ancho de banda. El limite
  // va antes del handler: si el cuerpo excede, express.raw corta la peticion.
  app.post(
    `${mount}/upload`,
    express.raw({ type: () => true, limit: IMAGE_MAX_BYTES }),
    async (request, response, next) => {
      const buffer = request.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return response.status(400).json({ error: "No llegó ninguna imagen." });
      }
      const type = images.sniffImage(buffer);
      if (!type) {
        return response
          .status(415)
          .json({ error: "Ese archivo no es una imagen (PNG, JPG, GIF o WebP)." });
      }
      try {
        const saved = await images.save(buffer, type);
        response.status(201).json(saved);
      } catch (error) {
        if (error?.status) return response.status(error.status).json({ error: error.message });
        return next(error);
      }
    },
    uploadErrorHandler,
  );

  // Servir una imagen por id opaco. Se responde con cache porque el id es
  // aleatorio y el contenido no cambia: el navegador no vuelve a bajarla.
  app.get(`${mount}/img/:id`, async (request, response, next) => {
    try {
      const image = await images.read(request.params.id);
      if (!image) return response.status(404).send("No existe esa imagen");
      response
        .type(image.type)
        .set("Cache-Control", "public, max-age=86400, immutable")
        .send(image.buffer);
    } catch (error) {
      next(error);
    }
  });
}

function cleanText(value, maxLength = 120) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Una imagen se referencia por id. Si el id no existe (o no es un string), se
// descarta en silencio: es opcional y una referencia vieja no debe romper la
// creación de la actividad.
function cleanImageId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return images.has(id) ? id : null;
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
      // Con imagen o solo con texto: el nombre sigue siendo obligatorio, asi
      // que un elemento sin texto y sin foto no llega a existir.
      labelImage: cleanImageId(pair?.labelImage),
      targetImage: cleanImageId(pair?.targetImage),
    }));
    if (pairs.some((pair) => !pair.label || !pair.target)) {
      return { error: "Cada elemento y cada zona deben tener un nombre." };
    }
    if (new Set(pairs.map((pair) => pair.label.toLowerCase())).size !== pairs.length) {
      return { error: "Los nombres de los elementos deben ser únicos." };
    }
    // Tope de imagenes por actividad: 20 pares x 2 lados.
    const used = new Set();
    for (const pair of pairs) {
      for (const id of [pair.labelImage, pair.targetImage]) if (id) used.add(id);
    }
    if (used.size > IMAGE_MAX_PER_ACTIVITY) {
      return { error: `Máximo ${IMAGE_MAX_PER_ACTIVITY} imágenes por actividad.` };
    }
    return { activity: { type, prompt, pairs } };
  }

  if (type === "sequence") {
    if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > 20) {
      return { error: "Añade entre 2 y 20 elementos para ordenar." };
    }
    const items = input.items.map((item) =>
      typeof item === "string" ? cleanText(item, 80) : cleanText(item?.text, 80));
    const itemImages = input.items.map((item) => cleanImageId(item?.image));
    if (items.some((item) => !item)) {
      return { error: "No dejes elementos vacíos." };
    }
    if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
      return { error: "Los nombres de los elementos deben ser únicos." };
    }
    return { activity: { type, prompt, items, itemImages } };
  }

  return { error: "Elige un tipo de actividad válido." };
}

const MAX_ROUNDS = 20;

// Una sesion es una lista de actividades: cada una es una ronda. Se validan
// todas por separado y el error dice en cual fallo, para que el host sepa que
// corregir sin contar de a uno.
function validateRounds(input) {
  if (!Array.isArray(input?.rounds) || input.rounds.length === 0) {
    return { error: "Agrega al menos una ronda." };
  }
  if (input.rounds.length > MAX_ROUNDS) {
    return { error: `Máximo ${MAX_ROUNDS} rondas por sesión.` };
  }
  const rounds = [];
  for (const [index, round] of input.rounds.entries()) {
    const result = validateActivity(round);
    if (result.error) {
      return { error: `Ronda ${index + 1}: ${result.error}` };
    }
    rounds.push(result.activity);
  }
  return { rounds };
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
    roundIndex: room.roundIndex,
    roundsCount: room.rounds.length,
    prompt: room.rounds[room.roundIndex].prompt,
    type: room.rounds[room.roundIndex].type,
    participants: [...room.participants.values()].map((participant) => ({
      name: participant.name,
      connected: participant.connected,
      // En la ronda actual. El total va aparte para el ranking acumulado.
      submitted: participant.answers[room.roundIndex] !== undefined,
      score: participant.answers[room.roundIndex] ?? null,
      total: participant.total,
    })),
  };
}

// Lo que ve el participante de la ronda en curso.
function participantActivity(room) {
  const activity = room.rounds[room.roundIndex];
  const base = {
    roundIndex: room.roundIndex,
    roundsCount: room.rounds.length,
  };
  if (activity.type === "zones") {
    const labels = activity.pairs.map((pair) => ({ text: pair.label, image: pair.labelImage }));
    const targets = [...new Set(activity.pairs.map((pair) => pair.target))].map((target) => ({
      text: target,
      image: activity.pairs.find((pair) => pair.target === target)?.targetImage ?? null,
    }));
    return { ...base, type: activity.type, prompt: activity.prompt, labels, targets };
  }

  // En secuencia los items van mezclados: la imagen tiene que viajar pegada al
  // texto, no en un array paralelo que se desalinea al barajar.
  const items = shuffled(activity.items.map((text, index) => ({
    text,
    image: activity.itemImages?.[index] ?? null,
  })));
  return { ...base, type: activity.type, prompt: activity.prompt, items };
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
    const result = validateRounds(input);
    if (result.error) return acknowledge?.({ error: result.error });

    const room = {
      code: makeRoomCode(),
      hostSocketId: socket.id,
      rounds: result.rounds,
      roundIndex: 0,
      participants: new Map(),
      open: true,
    };
    rooms.set(room.code, room);
    socket.join(room.code);
    acknowledge?.({ room: roomSummary(room), activity: participantActivity(room) });
  });

  socket.on("participant:join", (input, acknowledge) => {
    const normalizedCode = cleanText(input?.code, 6).toUpperCase();
    const participantName = cleanText(input?.name, 40);
    const room = rooms.get(normalizedCode);
    if (!room || !room.open) return acknowledge?.({ error: "No encontramos una actividad abierta con ese código." });
    if (!participantName) return acknowledge?.({ error: "Escribe tu nombre para entrar." });

    // Un socket que reconecta no debe perder lo que ya habia respondido: se
    // busca por nombre, que es lo unico que el participante elige.
    const previous = [...room.participants.values()].find((p) => p.name === participantName);
    room.participants.set(socket.id, {
      name: participantName,
      connected: true,
      answers: previous ? { ...previous.answers } : {},
      total: previous?.total ?? 0,
    });
    socket.join(room.code);
    acknowledge?.({
      room: roomSummary(room),
      activity: participantActivity(room),
      // Para repintar las rondas ya respondidas si el socket se reconectó.
      answers: [...room.participants.values()].find((p) => p.name === participantName).answers,
    });
    io.to(room.hostSocketId).emit("room:update", roomSummary(room));
  });

  socket.on("participant:submit", (input, acknowledge) => {
    const room = rooms.get(cleanText(input?.code, 6).toUpperCase());
    const participant = room?.participants.get(socket.id);
    if (!room || !room.open || !participant) {
      return acknowledge?.({ error: "La actividad ya no está disponible. Vuelve a entrar con un código activo." });
    }
    const roundIndex = room.roundIndex;
    if (participant.answers[roundIndex] !== undefined) {
      return acknowledge?.({ error: "Ya respondiste esta ronda." });
    }
    const score = answerScore(room.rounds[roundIndex], input?.answer);
    if (!score) return acknowledge?.({ error: "Completa todos los elementos antes de enviar." });

    participant.answers[roundIndex] = score;
    participant.total += score.correct;
    acknowledge?.({ score, total: participant.total, roundIndex });
    io.to(room.hostSocketId).emit("room:update", roomSummary(room));
    socket.emit("participant:submitted", { score, total: participant.total, roundIndex });
  });

  // Avanza a la ronda siguiente. Solo el host, y solo si la actual tiene al
  // menos una respuesta: pasar antes de que nadie conteste deja a la gente
  // mirando una consigna que ya quedo atras.
  socket.on("host:next", (input, acknowledge) => {
    const room = rooms.get(cleanText(input?.code, 6).toUpperCase());
    if (!room || room.hostSocketId !== socket.id || !room.open) return;
    if (room.roundIndex >= room.rounds.length - 1) {
      return acknowledge?.({ error: "Ya están todas las rondas." });
    }
    const answered = [...room.participants.values()]
      .filter((p) => p.answers[room.roundIndex] !== undefined).length;
    if (!answered) {
      return acknowledge?.({ error: "Nadie respondió esta ronda todavía." });
    }
    room.roundIndex += 1;
    const payload = { room: roomSummary(room), activity: participantActivity(room) };
    io.to(room.code).emit("round:changed", payload);
    acknowledge?.(payload);
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

// Que imagenes sigue usando alguna sala en curso. La barrida nunca borra una de
// estas: si se fuera, la ronda en curso se quedaria con cuadritos rotos.
/**
 * Ids de imagenes referenciadas por salas abiertas.
 * @param {Map<string, any>} rooms
 * @returns {Set<string>}
 */
function imagesInUse(rooms) {
  const inUse = new Set();
  for (const room of rooms.values()) {
    for (const round of room.rounds || []) {
      if (round.type === "zones") {
        for (const pair of round.pairs || []) {
          if (pair.labelImage) inUse.add(pair.labelImage);
          if (pair.targetImage) inUse.add(pair.targetImage);
        }
      } else {
        for (const id of round.itemImages || []) if (id) inUse.add(id);
      }
    }
  }
  return inUse;
}

// Las imagenes que ya no usa nadie se van solas: primero las que vencieron, y
// despues las mas viejas si el disco sigue pasado el tope. Sin esto, las que
// nunca llegan a una sala se acumulan para siempre y una vez llenado el tope
// ninguna subida vuelve a funcionar.
const IMAGE_SWEEP_MS = 30 * 60 * 1000;
function startImageSweep() {
  const sweep = () => {
    images.prune(() => imagesInUse(rooms)).then((removed) => {
      if (removed) console.log(`Barrida de imagenes: ${removed} borrada(s)`);
    }).catch((error) => console.error(`Falló la barrida de imagenes: ${error.message}`));
  };
  // unref: el temporizador no debe impedir que el proceso termine solo.
  const timer = setInterval(sweep, IMAGE_SWEEP_MS);
  timer.unref();
  sweep();
  return timer;
}

if (require.main === module) {
  // Sin host, Node escucha en todas las interfaces y la app queda accesible
  // desde toda la red local, saltandose el proxy. Lo atamos a loopback por
  // defecto: la entrada publica la define el proxy, no el proceso.
  const HOST = process.env.HOST || "127.0.0.1";
  // Las imagenes se cargan antes de escuchar: si se aceptaran peticiones antes,
  // has() responderia que no existe una imagen que si esta en disco y un borrador
  // restaurado perderia justamente lo que se pide conservar.
  images.load().then((result) => {
    if (result.loaded || result.discarded) {
      console.log(`Imagenes recuperadas de disco: ${result.loaded} (${result.discarded} descartadas)`);
    }
    startImageSweep();
    server.listen(PORT, HOST, () => {
      console.log(`Limlimclap disponible en http://${HOST}:${PORT}`);
    });
  }).catch((error) => {
    console.error(`No se pudo preparar el almacen de imagenes: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { answerScore, validateActivity };

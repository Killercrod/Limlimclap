// Almacen de imagenes en disco. Antes vivian en memoria del proceso: un
// reinicio las borraba y con ellas se iba la configuracion a medio hacer y las
// salas en curso. Ahora sobreviven, asi que hacen falta dos cosas que en memoria
// no hacia falta: decidir cuando se borra algo, y no dejar que el disco se llene.
//
// Decisiones:
//   - El id es un UUID y es la unica forma de llegar al archivo. Nunca se arma
//     una ruta con texto que venga del cliente: has() consulta el indice en
//     memoria y solo un id ya conocido pasa a tocarse el disco.
//   - El tipo MIME se deduce del contenido (firma), no de la extension ni de lo
//     que decia el navegador: se re-detecta al arrancar, asi que un archivo
//     manipulado a mano no se sirve como algo que no es.
//   - Se escribe a un temporal y se renombra. Un corte de luz a mitad de una
//     escritura deja un temporal suelto, nunca una imagen truncada.
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Solo UUID v4 con guion en hexadecimal. Es la primera barrera: aunque el id no
// estuviera en el indice, nunca podria salir de la carpeta de imagenes.
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// El tipo que declara el navegador no sirve para decidir nada: cualquiera puede
// mandar cualquier cosa. Se mira la firma del archivo.
const IMAGE_SIGNATURES = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

function sniffImage(buffer) {
  for (const { type, bytes } of IMAGE_SIGNATURES) {
    if (bytes.every((byte, index) => buffer[index] === byte)) {
      // WebP comparte firma RIFF con WAV: se confirma el "WEBP" de los bytes 8-11.
      if (type === "image/webp" && buffer.toString("ascii", 8, 12) !== "WEBP") continue;
      return type;
    }
  }
  return null;
}

// Error con estado HTTP, para que el servidor no tenga que adivinar que paso.
class ImageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createImageStore({
  dir,
  maxBytes = 2 * 1024 * 1024,
  maxCount = 2000,
  maxTotalBytes = 64 * 1024 * 1024,
  ttlMs = 72 * 60 * 60 * 1000,
} = {}) {
  if (!dir) throw new Error("image-store necesita dir");
  // id -> { type, bytes, savedAt }
  const index = new Map();

  const filePath = (id) => path.join(dir, id);

  function totalBytes() {
    let total = 0;
    for (const image of index.values()) total += image.bytes;
    return total;
  }

  function has(id) {
    return typeof id === "string" && index.has(id);
  }

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Recorre el directorio al arrancar. El tipo se vuelve a detectar desde los
  // bytes, no se guarda en ningun lado: si no se puede reconocer el archivo se
  // descarta, porque no sabriamos que Content-Type mandarle.
  async function load() {
    await ensureDir();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { loaded: 0, discarded: 0 };
    }

    let loaded = 0;
    let discarded = 0;
    for (const entry of entries) {
      // Los temporales de una escritura interrumpida y cualquier otra cosa que
      // no sea un UUID se ignoran (y se limpian).
      if (!entry.isFile() || !ID_PATTERN.test(entry.name)) {
        await fs.rm(path.join(dir, entry.name), { force: true, recursive: true }).catch(() => {});
        discarded += 1;
        continue;
      }
      const target = path.join(dir, entry.name);
      try {
        const buffer = await fs.readFile(target);
        const type = sniffImage(buffer);
        if (!type || buffer.length > maxBytes) {
          await fs.rm(target, { force: true });
          discarded += 1;
          continue;
        }
        const stats = await fs.stat(target);
        index.set(entry.name, { type, bytes: buffer.length, savedAt: stats.mtimeMs });
        loaded += 1;
      } catch {
        discarded += 1;
      }
    }
    return { loaded, discarded };
  }

  async function save(buffer, type) {
    if (totalBytes() + buffer.length > maxTotalBytes) {
      throw new ImageError(429, "Se alcanzó el máximo de imágenes guardadas en el servidor.");
    }
    if (index.size >= maxCount) {
      throw new ImageError(429, `Máximo ${maxCount} imágenes guardadas.`);
    }

    const id = crypto.randomUUID();
    const target = filePath(id);
    // Se escribe junto al destino y se renombra: renombrar dentro del mismo
    // sistema de archivos es atomico, asi que nunca hay un id publicado con un
    // archivo a medio escribir.
    const temporary = path.join(dir, `.tmp-${id}`);
    try {
      await fs.writeFile(temporary, buffer, { mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw new ImageError(500, "No se pudo guardar la imagen.");
    }
    index.set(id, { type, bytes: buffer.length, savedAt: Date.now() });
    return { id, type, bytes: buffer.length };
  }

  async function read(id) {
    if (!has(id)) return null;
    const entry = index.get(id);
    try {
      return { buffer: await fs.readFile(filePath(id)), type: entry.type };
    } catch {
      // El indice dice que esta pero el archivo no se puede leer: se saca del
      // indice para que el proximo pedido no vuelva a intentar.
      index.delete(id);
      return null;
    }
  }

  async function remove(id) {
    if (!index.has(id)) return;
    index.delete(id);
    await fs.rm(filePath(id), { force: true }).catch(() => {});
  }

  // La edad se lee del archivo y no del indice: el mtime es la fuente real y no
  // depende de que el proceso siga vivo desde que se guardo. Por eso mismo
  // prune() pide un stat por imagen, pero solo corre cada media hora.
  async function ageOf(id, fallback) {
    try {
      const stats = await fs.stat(filePath(id));
      return stats.mtimeMs;
    } catch {
      return fallback;
    }
  }

  // Borra lo que ya no se usa. Primero lo que vencio, y si aun asi sigue pasado
  // el tope de disco, lo mas viejo sin usar. Lo que una sala en curso referencia
  // no se toca nunca, aunque sea viejito: borrarselo dejaria la ronda a medias.
  async function prune(isInUse) {
    const inUse = typeof isInUse === "function" ? isInUse() : new Set();
    let removed = 0;

    const entries = [];
    for (const [id, image] of index) {
      entries.push([id, image, await ageOf(id, image.savedAt)]);
    }
    entries.sort((a, b) => a[2] - b[2]);

    const now = Date.now();
    for (const [id, , savedAt] of entries) {
      if (inUse.has(id)) continue;
      if (now - savedAt <= ttlMs) continue;
      await remove(id);
      removed += 1;
    }

    let total = totalBytes();
    for (const [id, image] of entries) {
      if (total <= maxTotalBytes) break;
      if (inUse.has(id) || !index.has(id)) continue;
      await remove(id);
      total -= image.bytes;
      removed += 1;
    }
    return removed;
  }

  function stats() {
    return { count: index.size, totalBytes: totalBytes(), dir, ttlMs, maxTotalBytes };
  }

  return { load, save, read, remove, prune, has, stats, totalBytes, sniffImage, ImageError, MAX_BYTES: maxBytes };
}

module.exports = { createImageStore, sniffImage, ImageError, ID_PATTERN };
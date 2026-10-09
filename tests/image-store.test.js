// Pruebas del almacen de imagenes en disco. Lo que importa aqui es que una
// imagen sobreviva a que el proceso se muera y vuelva, y que no se pueda ni
// leer un archivo de fuera ni dejar el disco lleno.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { createImageStore, sniffImage, ID_PATTERN } = require("../image-store");

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "limlim-imgs-"));
}

test("reconoce el tipo por la firma, no por la extension", () => {
  assert.strictEqual(sniffImage(PNG), "image/png");
  assert.strictEqual(sniffImage(JPEG), "image/jpeg");
  // RIFF tambien lo usan los WAV: no puede pasar por WebP.
  assert.strictEqual(sniffImage(WAV), null);
  assert.strictEqual(sniffImage(Buffer.from("no soy una imagen")), null);
  assert.strictEqual(sniffImage(Buffer.alloc(0)), null);
});

test("una imagen guardada se vuelve a leer después de reabrir el almacén", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir });
  await store.load();
  const { id, type } = await store.save(PNG, "image/png");
  assert.ok(ID_PATTERN.test(id), `el id debe ser un UUID: ${id}`);

  // Proceso nuevo, mismo directorio: es literalmente lo que pasa al reiniciar.
  const otro = createImageStore({ dir });
  const cargado = await otro.load();
  assert.strictEqual(cargado.loaded, 1);
  assert.ok(otro.has(id));

  const leida = await otro.read(id);
  assert.ok(leida, "la imagen debe seguir disponible");
  assert.strictEqual(leida.type, type);
  assert.ok(leida.buffer.equals(PNG));
});

test("el archivo guardado no lleva extensión ni caracteres raros", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir });
  await store.load();
  const { id } = await store.save(PNG, "image/png");
  const archivos = await fs.readdir(dir);
  assert.deepStrictEqual(archivos, [id]);
});

test("un id desconocido no se puede usar para leer un archivo de fuera", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir });
  await store.load();
  const secreto = path.join(dir, "..", "fuera.txt");
  await fs.writeFile(secreto, "no deberia leerse");

  for (const intento of ["../../fuera.txt", "..%2Ffuera.txt", "secreto", "", "constructor", null, 42]) {
    assert.strictEqual(await store.read(intento), null, `no deberia devolver nada para ${intento}`);
    assert.strictEqual(store.has(intento), false);
  }
  await fs.rm(secreto, { force: true });
});

test("al arrancar descarta lo que no es una imagen y no rompe con lo que hay", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir });
  await store.load();
  const { id } = await store.save(PNG, "image/png");

  // Simula un directorio con basura: un temporal de una escritura cortada, un
  // archivo que no es UUID y uno con nombre de UUID pero que no es una imagen.
  const basura = [
    `.tmp-${id}`,
    "notas.txt",
    "00000000-0000-4000-8000-000000000000",
  ];
  for (const nombre of basura) await fs.writeFile(path.join(dir, nombre), "basura");

  const otro = createImageStore({ dir });
  const resultado = await otro.load();
  assert.strictEqual(resultado.loaded, 1, "solo debe recuperar la imagen buena");
  assert.strictEqual(resultado.discarded, 3);
  assert.deepStrictEqual((await fs.readdir(dir)).sort(), [id].sort());
  assert.ok(otro.has(id), "la imagen buena tiene que sobrevivir a la limpieza");
});

test("no se escribe nada cuando se supera el tope de tamaño total", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir, maxTotalBytes: PNG.length });
  await store.load();
  await store.save(PNG, "image/png");
  await assert.rejects(
    () => store.save(PNG, "image/png"),
    (error) => error.status === 429,
  );
  // El rechazo tiene que venir sin dejar un archivo a medias.
  assert.strictEqual((await fs.readdir(dir)).length, 1);
});

test("no se escribe nada cuando se supera el tope de cantidad", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir, maxCount: 2 });
  await store.load();
  await store.save(PNG, "image/png");
  await store.save(PNG, "image/png");
  await assert.rejects(() => store.save(PNG, "image/png"), (error) => error.status === 429);
});

test("la barrida borra lo que no se usa y lo que venció", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir, ttlMs: 10 });
  await store.load();
  const vieja = (await store.save(PNG, "image/png")).id;
  const nueva = (await store.save(PNG, "image/png")).id;

  // Se hace pasar la vieja por antigua.
  const antiguas = Date.now() / 1000 - 60;
  await fs.utimes(path.join(dir, vieja), antiguas, antiguas);

  const enUso = new Set([vieja]);
  assert.strictEqual(await store.prune(() => enUso), 0, "una imagen en uso no se borra aunque sea vieja");
  assert.ok(store.has(vieja));

  // Sin sala que la use: ya puede irse.
  assert.strictEqual(await store.prune(() => new Set()), 1);
  assert.strictEqual(store.has(vieja), false);
  assert.ok(store.has(nueva), "la reciente se queda");
});

test("la barrida respeta el tope de disco aunque nada haya vencido", async () => {
  const dir = await tmpDir();
  // Con el tope alto entran las tres...
  const alto = createImageStore({ dir, maxTotalBytes: PNG.length * 10, ttlMs: 60_000 });
  await alto.load();
  const a = (await alto.save(PNG, "image/png")).id;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = (await alto.save(PNG, "image/png")).id;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const c = (await alto.save(PNG, "image/png")).id;

  // ...y despues se baja el tope, como cuando se ajusta la configuracion. Sin
  // la rama de la barrida, el disco se queda pasado de limite para siempre.
  const bajo = createImageStore({ dir, maxTotalBytes: PNG.length * 2, ttlMs: 60_000 });
  await bajo.load();
  const enUso = new Set([b]);
  assert.strictEqual(await bajo.prune(() => enUso), 1);
  assert.strictEqual(bajo.has(a), false);
  assert.ok(bajo.has(b), "la que una sala usa no se toca");
  assert.ok(bajo.has(c));
});

test("los archivos se escriben con permisos restrictivos", async () => {
  const dir = await tmpDir();
  const store = createImageStore({ dir });
  await store.load();
  const { id } = await store.save(PNG, "image/png");
  const stats = await fs.stat(path.join(dir, id));
  assert.strictEqual(stats.mode & 0o777, 0o600);
});
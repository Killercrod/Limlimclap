// El QR del panel de la sala se genera con la libreria de un tercero y se sirve
// como imagen. Un SVG que "se ve bien" no dice si se puede leer, asi que aca se
// decodifica: la misma matriz que dibuja el QR pasa por un lector independiente
// (jsQR, Apache-2.0, solo dev) y tiene que devolver el enlace exacto.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const jsQR = require("jsqr");

const QR_PATH = path.join(__dirname, "..", "public", "vendor", "qrcode.js");

// La libreria del navegador, tal cual la sirve la app.
function cargarQrcode() {
  const contexto = vm.createContext({});
  vm.runInContext(fs.readFileSync(QR_PATH, "utf8"), contexto);
  assert.strictEqual(typeof contexto.qrcode, "function", "el archivo debe exponer qrcode()");
  return contexto.qrcode;
}

// Convierte la matriz del QR en pixeles, como si se dibujara, para pasarsela al
// lector. Sin el margen blanco que exige el formato, el lector no arranca.
function aPixeles(qr, escala = 4, margen = 4) {
  const modulos = qr.getModuleCount();
  const lado = (modulos + margen * 2) * escala;
  const datos = new Uint8ClampedArray(lado * lado * 4);
  for (let y = 0; y < lado; y += 1) {
    for (let x = 0; x < lado; x += 1) {
      const mx = Math.floor(x / escala) - margen;
      const my = Math.floor(y / escala) - margen;
      const oscuro = mx >= 0 && my >= 0 && mx < modulos && my < modulos && qr.isDark(my, mx);
      const i = (y * lado + x) * 4;
      const valor = oscuro ? 0 : 255;
      datos[i] = valor;
      datos[i + 1] = valor;
      datos[i + 2] = valor;
      datos[i + 3] = 255;
    }
  }
  return { datos, lado };
}

function generar(qrcode, texto, correccion = "M") {
  const qr = qrcode(0, correccion);
  qr.addData(texto);
  qr.make();
  return qr;
}

test("el QR del panel se lee y devuelve el enlace con el codigo de la sala", () => {
  const qrcode = cargarQrcode();
  const enlace = "https://run-it-server.tail32f6e5.ts.net/limlimclap/?join=ABC123";
  const qr = generar(qrcode, enlace);
  const { datos, lado } = aPixeles(qr);
  const leido = jsQR(datos, lado, lado);
  assert.ok(leido, "el QR tiene que poder leerse con un lector independiente");
  assert.strictEqual(leido.data, enlace);
});

test("aguanta un enlace largo sin dejar de leerse", () => {
  const qrcode = cargarQrcode();
  // Con un dominio propio mas un prefijo y un codigo, el enlace no es corto.
  const enlace = "https://run-it-server.tail32f6e5.ts.net/limlimclap/?join=K7QX2M";
  const qr = generar(qrcode, enlace);
  const { datos, lado } = aPixeles(qr);
  const leido = jsQR(datos, lado, lado);
  assert.ok(leido, "un enlace de dominio largo tiene que seguir siendo legible");
  assert.strictEqual(leido.data, enlace);
});

test("codigos de sala distintos dan QRs distintos", () => {
  const qrcode = cargarQrcode();
  const uno = generar(qrcode, "https://ejemplo.test/app/?join=AAAAA");
  const dos = generar(qrcode, "https://ejemplo.test/app/?join=BBBBB");
  const { datos: d1, lado: l1 } = aPixeles(uno);
  const { datos: d2, lado: l2 } = aPixeles(dos);
  assert.strictEqual(jsQR(d1, l1, l1).data, "https://ejemplo.test/app/?join=AAAAA");
  assert.strictEqual(jsQR(d2, l2, l2).data, "https://ejemplo.test/app/?join=BBBBB");
});

test("el SVG que se inserta en la pagina se arma bien", () => {
  const qrcode = cargarQrcode();
  const qr = generar(qrcode, "https://ejemplo.test/app/?join=ABC123");
  const svg = qr.createSvgTag({ cellSize: 4, scalable: true, alt: "Código QR para entrar a la sala" });
  assert.ok(svg.startsWith("<svg"), "tiene que ser un SVG");
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, "sin viewBox no se puede escalar con CSS");
  assert.doesNotMatch(svg, /width="\d+px"/, "scalable omite el ancho fijo para que lo controle el CSS");
  assert.match(svg, /<path d="/, "los modulos van en un path");
  assert.ok(svg.includes("role=\"img\""), "lleva texto alternativo para lectores de pantalla");
});
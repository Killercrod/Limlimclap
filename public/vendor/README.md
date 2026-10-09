# Archivos de terceros

## qrcode.js

Generador de códigos QR usado por el panel de la sala, para que el grupo entre
escan instead de escribir el código a mano.

- Paquete: `qrcode-generator` 2.0.4
- Licencia: MIT
- Copiado de `node_modules/qrcode-generator/dist/qrcode.js`, sin modificar.

Se copia acá a propósito y no se carga desde node_modules: la app se publica
con `node server.js`, sin paso de compilación, y así el QR funciona aunque el
equipo no tenga internet. Para actualizarlo, se copia de nuevo el archivo de
`node_modules` después de `npm install qrcode-generator@<version>`.

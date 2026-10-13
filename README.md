# Limlimclap

Aplicación web colaborativa para actividades interactivas de arrastrar y soltar. Un anfitrión crea una sala y comparte su código, QR o enlace; participantes externos entran sin registrarse.

## Funciones incluidas

- Dos modos de juego: **colocar en zonas** y **ordenar secuencia**.
- Flujo en directo con Socket.IO: sala de espera, inicio del anfitrión, cierre y resultados.
- **Temporizador opcional** por actividad.
- **Ranking en vivo** y métricas por elemento para el anfitrión.
- **Código QR** de acceso por sala.
- Reconexión de participantes por token de sesión.
- Sonido opcional, confeti, feedback de aciertos por elemento, modo proyector.
- Plantillas rápidas para crear actividades.
- Tema de color por actividad.
- Metaetiquetas SEO/OG, favicon y página de privacidad básica.

## Empezar en local

Requiere Node.js 18 o posterior.

```sh
npm install
npm start
```

Abre `http://localhost:3000`.

## Pruebas

```sh
npm test
```

## Publicación para participantes externos

Despliega este servidor Node.js en un servicio accesible por Internet que admita conexiones WebSocket, y comparte el enlace generado por la sala. Configura el servicio para ejecutar `npm start` y proporcionar el puerto mediante `PORT` si corresponde.

## Limitaciones actuales

- Las salas y respuestas se guardan en memoria; se eliminan al cerrar sala, expirar, desconectarse el anfitrión por más de 90 segundos o reiniciar el servidor.
- No hay cuentas persistentes de anfitrión ni base de datos.
- El host token vive en `sessionStorage` del navegador; si se cierra la sesión del navegador se pierde.

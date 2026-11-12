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

### Render (plan gratuito)

El repositorio incluye `render.yaml`, así que Render lo configura solo:

1. En [Render](https://render.com), entra con tu cuenta de GitHub.
2. Elige **New > Blueprint** y selecciona este repositorio.
3. Confirma el servicio `limlimclap` (plan *Free*) y espera a que termine el despliegue.

En el plan gratuito el servidor se suspende tras unos minutos sin visitas y tarda cerca de un minuto en despertar. Como las salas viven en memoria, se pierden cuando se suspende o se reinicia.

Variables de entorno:

| Variable | Uso |
|---|---|
| `PORT` | Puerto del servidor (Render lo define). |
| `TRUST_PROXY` | Ponla en `1` detrás de un proxy para que los enlaces y el QR usen `https`. |
| `BASE_PATH` | Opcional: prefijo si la app no se sirve en la raíz (por ejemplo `/limlimclap`). |

## Limitaciones actuales

- Las salas y respuestas se guardan en memoria; se eliminan al cerrar sala, expirar, desconectarse el anfitrión por más de 90 segundos o reiniciar el servidor.
- No hay cuentas persistentes de anfitrión ni base de datos.
- El host token vive en `sessionStorage` del navegador; si se cierra la sesión del navegador se pierde.

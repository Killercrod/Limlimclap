# Limlimclap

Aplicación web colaborativa para actividades interactivas de arrastrar y soltar. Un anfitrión crea una sala y comparte su código o enlace; participantes externos entran sin registrarse.

## Empezar en local

Requiere Node.js 18 o posterior.

```sh
npm install
npm start
```

Abre `http://localhost:3000`. Para probar la participación en tiempo real, abre el enlace de la sala en otra ventana o dispositivo conectado al mismo servidor.

## Actividades disponibles

- **Colocar en zonas:** escribe una relación por línea con el formato `Elemento → Zona`. Se pueden repetir zonas.
- **Ordenar secuencia:** escribe un elemento por línea y en el orden correcto; el orden se mezcla para cada participante.

En móvil, toca un elemento y después la zona o posición para colocarlo. En ordenador también puedes arrastrar y soltar.

## Publicar para participantes externos

Despliega este servidor Node.js en un servicio accesible por Internet que admita conexiones WebSocket, y comparte el enlace generado por la sala. Configura el servicio para ejecutar `npm start` y proporcionar el puerto mediante `PORT` si corresponde. No se necesita una cuenta de participante.

Las salas y respuestas se guardan en memoria y se eliminan al cerrar la sala, desconectarse el anfitrión o reiniciar el servidor. Para esta primera versión, usa una sola instancia del servidor y mantén abierta la pestaña del anfitrión mientras dure la actividad. No hay cuentas de anfitrión ni moderación de participantes.

Las **imágenes sí se guardan en disco**, en el directorio que indique `IMAGE_DIR` (por defecto `/var/lib/limlimclap/imagenes`), así que sobreviven a un reinicio. No se borran al reiniciar: se limpian solas con una barrida cada 30 minutos que elimina las que ninguna sala usa y las que pasaron las 72 horas, más un ajuste por peso si el disco pasa del tope. El directorio queda fuera del repositorio y el servicio necesita permiso de escritura ahí (`ReadWritePaths` en la unidad de systemd).

## Pruebas

```sh
npm test
```

# Bitácora calórica — deploy en Netlify

## 1. Subir el sitio
Arrastrá esta carpeta completa a Netlify (Sites → Add new site → Deploy manually),
o conectala a un repo de GitHub. Todos los archivos (index.html, manifest.json, sw.js,
/icons, /netlify/functions/ai.js, netlify.toml) deben quedar en la raíz del sitio.

## 2. Variables de entorno (Site settings → Environment variables)
- `ANTHROPIC_API_KEY`: tu API key de la consola de Anthropic (console.anthropic.com).
- `APP_TOKEN`: una clave inventada por vos (cualquier string largo y random).

## 3. Igualar el token en el front
Abrí index.html y reemplazá:
```
const APP_TOKEN = 'CAMBIAR-ESTE-TOKEN';
```
por el mismo valor que pusiste como `APP_TOKEN` en Netlify. Sin esto, la función
de IA (fotos y rutina) va a rechazar las llamadas con error 401.

## 4. Redeploy
Después de cargar las variables de entorno, forzá un nuevo deploy (Netlify no las
aplica retroactivamente a un deploy ya hecho).

## 5. Instalar como app en el celular
Abrí la URL de Netlify desde el navegador del celular → menú → "Agregar a pantalla
de inicio" / "Instalar app". Con el manifest.json y el service worker ya armados,
debería instalarse como una app real (ícono propio, pantalla completa, sin la barra
del navegador), y el shell de la app queda cacheado para abrir aunque no haya señal
(la carga de datos en sí necesita conexión, salvo lo que ya esté en caché local).

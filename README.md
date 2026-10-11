# Generador web de imágenes y videos

Aplicación local para preparar piezas de **Tazón para Dos** sin modificar ni hacer commits en el repositorio de marca.

## Iniciar

### En Windows

Doble clic en `iniciar.bat`. Abre el panel en el navegador (`http://127.0.0.1:8765`).

O desde una terminal:

```powershell
cd D:\generador-web
python -X utf8 server.py --abrir
```

Requisitos: Python 3.10+, Microsoft Edge o Google Chrome (para renderizar las plantillas) y ffmpeg para los videos (`winget install Gyan.FFmpeg`).
El kit de marca debe estar en la carpeta vecina `D:\tazon-para-dos-marca`; si está en otra ruta: `set BRAND_REPO=D:\ruta\al\kit` antes de iniciar.

### En Termux

Desde Termux:

```bash
cd ~/git/generador-web
python server.py
```

Luego abre `http://127.0.0.1:8765`.

La aplicación usa por defecto el repositorio vecino:

```text
~/git/tazon-para-dos-marca
```

Si está en otra ruta:

```bash
BRAND_REPO=/ruta/al/tazon-para-dos-marca python server.py
```

## Qué hace

- Crea proyectos de trabajo independientes.
- Guarda notas, textos y comentarios.
- Recibe varias fotos o videos en un álbum.
- Conserva las rutas relativas dentro de cada proyecto.
- Muestra un formulario con los campos de cada plantilla (leídos de `editor/templates.js` del kit) y una vista previa en vivo; las fotos del proyecto se eligen en una lista. Los valores en JSON siguen disponibles en «avanzado».
- Genera jobs JSON para `tools/render_editor.py`.
- Genera guiones JSON para `tools/montaje.py`.
- Videos en todas las líneas: Editorial y Mesa/Zine (líneas oficiales), TikTok, clásica, banda, stickers y marco. Los estilos y sus ventanas se leen de `tools/montaje.py`, y los campos de la marca de cada estilo de su plantilla, así el panel sigue al kit cuando cambie.
- Vista previa del video: el primer segmento con la capa de marca, el titular o subtítulo y el gancho, tal como los pone el montaje.
- Segmentos ordenables con flechas: desde qué segundo empieza cada clip, duración, encuadre (incluye extremos para no cortar a quien narra), texto y separadores (tarjetas de capítulo).
- TikTok: gancho inicial, 5 estilos de subtítulo (karaoke, caja, recorte, pop, editorial), tarjeta de cierre Zine o Editorial y formato lista (Top N con número y título). Al elegirlo apaga la intro y acorta los segmentos a 3 s, como recomienda el kit.
- Muestra cada imagen o video generado en el panel (con reproductor) y guarda una galería de resultados por proyecto.
- Ejecuta los scripts Python y muestra su salida.
- Puede regenerar el kit de video con `tools/video.py`.
- Puede validar todas las plantillas con `tools/validar.py` (debe dar 0 errores).

Los archivos de trabajo quedan en `projects/`. Esa carpeta está preparada para ignorar medios y resultados grandes al subir este proyecto a Git.

## Compatibilidad con el kit

El panel depende de la forma de algunos scripts y archivos del kit (lista de plantillas, constantes de `tools/montaje.py`, modo `embed` del editor). El kit trae `tools/generador.py`, que revisa ese contrato. El panel lo ejecuta al iniciar y en `/api/estado`, y si algo no cuadra muestra un aviso arriba. `tools/validar.py` del kit también lo revisa.

## Nota sobre privacidad

No subas fotos de personas identificables a un repositorio público. Usa esta aplicación local y solicita consentimiento antes de publicar rostros o nombres.

## Seguridad

El panel solo escucha en `127.0.0.1` (este equipo). Del kit de marca solo expone, en modo lectura, `editor/`, `brand/`, `assets/` y `tools/fonts/` (para la vista previa); nunca `.git` ni los scripts.

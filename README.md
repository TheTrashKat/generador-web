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
- Videos en todas las líneas: Editorial, Mesa/Zine, TikTok (gancho y 5 estilos de subtítulo), clásica, banda, stickers y marco.
- Ejecuta los scripts Python y muestra su salida.
- Puede regenerar el kit de video con `tools/video.py`.

Los archivos de trabajo quedan en `projects/`. Esa carpeta está preparada para ignorar medios y resultados grandes al subir este proyecto a Git.

## Nota sobre privacidad

No subas fotos de personas identificables a un repositorio público. Usa esta aplicación local y solicita consentimiento antes de publicar rostros o nombres.

## Seguridad

El panel solo escucha en `127.0.0.1` (este equipo). Del kit de marca solo expone, en modo lectura, `editor/`, `brand/`, `assets/` y `tools/fonts/` (para la vista previa); nunca `.git` ni los scripts.

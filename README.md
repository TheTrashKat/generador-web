# Generador web de imágenes y videos

Aplicación local para preparar piezas de **Tazón para Dos** sin modificar ni hacer commits en el repositorio de marca.

## Iniciar

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
- Genera jobs JSON para `tools/render_editor.py`.
- Genera guiones JSON para `tools/montaje.py`.
- Ejecuta los scripts Python y muestra su salida.
- Puede regenerar el kit de video con `tools/video.py`.

Los archivos de trabajo quedan en `projects/`. Esa carpeta está preparada para ignorar medios y resultados grandes al subir este proyecto a Git.

## Nota sobre privacidad

No subas fotos de personas identificables a un repositorio público. Usa esta aplicación local y solicita consentimiento antes de publicar rostros o nombres.

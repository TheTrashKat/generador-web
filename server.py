#!/usr/bin/env python3
"""Panel local para preparar y ejecutar los generadores de Tazón para Dos."""
from __future__ import annotations

import ast
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parent
BRAND = Path(os.environ.get("BRAND_REPO", ROOT.parent / "tazon-para-dos-marca")).expanduser().resolve()
PROJECTS = ROOT / "projects"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
STATIC = ROOT / "static"
PORT = int(os.environ.get("PORT", "8765"))
MAX_UPLOAD = 1024 * 1024 * 1024
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
# Windows toma los tipos MIME del registro y a veces sirve .js como text/plain: se fijan aquí.
for _ext, _kind in {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
                    ".ttf": "font/ttf", ".webp": "image/webp", ".mp4": "video/mp4", ".png": "image/png"}.items():
    mimetypes.add_type(_kind, _ext)
# Partes del kit de marca que el panel puede leer (vista previa y formularios). Nunca .git ni salidas.
BRAND_PUBLIC = ("editor/", "brand/", "assets/", "tools/fonts/")


def now_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]


def clean_name(value: str, fallback: str = "archivo") -> str:
    value = Path(value or fallback).name
    value = re.sub(r"[^\w.() -]", "_", value, flags=re.UNICODE).strip(" .")
    return value[:150] or fallback


def project_path(pid: str) -> Path:
    if not re.fullmatch(r"[\w-]+", pid):
        raise ValueError("Proyecto inválido")
    path = (PROJECTS / pid).resolve()
    if path.parent != PROJECTS.resolve():
        raise ValueError("Proyecto inválido")
    return path


def ensure_project_dirs(path: Path):
    """Asegura la estructura que necesitan las cargas y los trabajos."""
    for folder in (path / "media", path / "jobs", path / "outputs"):
        folder.mkdir(parents=True, exist_ok=True)


def project_asset(path: Path, value: str) -> str:
    """Convierte rutas del proyecto a rutas absolutas para los scripts externos.

    Los jobs se guardan dentro de ``project/jobs``. Si se deja una ruta como
    ``media/foto.mp4``, montaje.py la resolvería como ``jobs/media/foto.mp4``.
    La API recibe rutas relativas a la raíz del proyecto, por eso las
    normalizamos antes de escribir el job.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("La ruta del archivo está vacía")
    candidate = Path(value).expanduser()
    return str(candidate.resolve() if candidate.is_absolute() else (path / candidate).resolve())


def project_output(path: Path, value: str) -> str:
    """Resuelve una salida relativa a la raíz del proyecto."""
    candidate = Path(value).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (path / candidate).resolve()
    root = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("La salida debe estar dentro del proyecto")
    return str(resolved)


def normalize_image_values(path: Path, value):
    """Hace absolutas las rutas de imágenes subidas, incluso dentro de listas."""
    if isinstance(value, dict):
        return {key: normalize_image_values(path, item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_image_values(path, item) for item in value]
    if isinstance(value, str) and not value.startswith(("data:", "http")):
        candidate = Path(value)
        if candidate.suffix.lower() in IMAGE_EXTENSIONS and (value.startswith("media/") or value.startswith("./media/")):
            return project_asset(path, value)
    return value


def metadata(path: Path) -> dict:
    file = path / "project.json"
    if not file.exists():
        return {}
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def files_in(path: Path) -> list[dict]:
    media = path / "media"
    result = []
    for item in sorted(media.glob("*")):
        if item.is_file():
            kind = "video" if item.suffix.lower() in {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"} else "image"
            result.append({"name": item.name, "path": f"media/{item.name}", "kind": kind, "size": item.stat().st_size})
    return result


def outputs_in(path: Path) -> list[dict]:
    items = [i for i in (path / "outputs").glob("*") if i.is_file() and i.suffix.lower() in {".png", ".mp4", ".jpg", ".svg"}]
    items.sort(key=lambda i: i.stat().st_mtime, reverse=True)
    return [{"name": i.name, "path": f"outputs/{i.name}", "kind": "video" if i.suffix.lower() == ".mp4" else "image",
             "size": i.stat().st_size, "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(i.stat().st_mtime))} for i in items]


def project_json(path: Path) -> dict:
    data = metadata(path)
    data["id"] = path.name
    data["files"] = files_in(path)
    data["outputs"] = outputs_in(path)
    data["paths"] = {
        "root": str(path),
        "media": str(path / "media"),
        "jobs": str(path / "jobs"),
        "outputs": str(path / "outputs"),
    }
    return data


def disposition(name: str) -> str:
    """Encabezado de descarga válido aunque el nombre tenga tildes u otros caracteres."""
    ascii_name = clean_name(name).encode("ascii", "replace").decode().replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(clean_name(name))}"


def json_response(handler: BaseHTTPRequestHandler, payload: dict, status: int = 200):
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except BrokenPipeError:
        # El navegador puede cancelar la solicitud al recargar durante un render.
        pass


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    if length > MAX_UPLOAD:
        raise ValueError("La solicitud es demasiado grande")
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8")) if raw else {}


def read_multipart(handler: BaseHTTPRequestHandler) -> list[tuple[str, str, bytes]]:
    content_type = handler.headers.get("Content-Type", "")
    match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", content_type)
    if not match:
        raise ValueError("Falta el boundary del formulario")
    boundary = (match.group(1) or match.group(2)).encode()
    length = int(handler.headers.get("Content-Length", "0"))
    if length > MAX_UPLOAD:
        raise ValueError("Los archivos superan el límite de 1 GB")
    body = handler.rfile.read(length)
    result = []
    for part in body.split(b"--" + boundary):
        if b"\r\n\r\n" not in part:
            continue
        raw_headers, content = part.split(b"\r\n\r\n", 1)
        if content.endswith(b"\r\n"):
            content = content[:-2]
        headers = raw_headers.decode("latin-1")
        disposition = re.search(r"Content-Disposition:\s*form-data;\s*name=\"([^\"]+)\"(?:;\s*filename=\"([^\"]*)\")?", headers, re.I)
        if disposition and disposition.group(2):
            result.append((disposition.group(1), clean_name(disposition.group(2)), content))
    return result


def run_python(script: Path, args: list[str], cwd: Path, timeout: int = 1800) -> dict:
    if not script.exists():
        return {"ok": False, "error": f"No existe: {script}"}
    try:
        proc = subprocess.run([os.environ.get("PYTHON") or sys.executable, "-I", "-X", "utf8", str(script), *args], cwd=cwd,
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return {"ok": proc.returncode == 0, "code": proc.returncode,
                "stdout": proc.stdout[-12000:], "stderr": proc.stderr[-12000:]}
    except subprocess.TimeoutExpired as exc:
        return {"ok": False, "error": "El proceso superó el tiempo límite", "stdout": (exc.stdout or "")[-12000:]}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


def templates() -> list[dict]:
    script = BRAND / "tools" / "render_editor.py"
    result = run_python(script, ["--list"], BRAND, timeout=60)
    found = []
    for line in result.get("stdout", "").splitlines():
        match = re.match(r"^(\S+)\s+(\d+x\d+)\s+(.+)$", line)
        if match:
            found.append({"id": match.group(1), "size": match.group(2), "name": match.group(3)})
    return found or [
        {"id": "post_general", "size": "1080x1080", "name": "Post general"},
        {"id": "historia_general", "size": "1080x1920", "name": "Historia general"},
        {"id": "evento_vertical", "size": "1080x1350", "name": "Evento semanal"},
        {"id": "video_portada", "size": "1080x1920", "name": "Portada de video"},
    ]


def montaje_consts() -> dict:
    """Constantes literales de tools/montaje.py, sin ejecutarlo."""
    consts = {}
    try:
        for node in ast.parse((BRAND / "tools" / "montaje.py").read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                try:
                    consts[node.targets[0].id] = ast.literal_eval(node.value)
                except ValueError:
                    pass
    except (OSError, SyntaxError):
        pass
    return consts


def thumbnail(project: Path, target: Path, at: float, width: int) -> Path:
    """Fotograma JPG de un video (con mapeo de tonos si es HDR), guardado en project/thumbs.

    Los navegadores en Windows no muestran videos HEVC/HDR de celular; el fotograma sí se ve en todos.
    """
    stat = target.stat()
    key = hashlib.sha1(f"{target.name}|{stat.st_mtime_ns}|{at:.2f}|{width}".encode()).hexdigest()[:20]
    out = project / "thumbs" / f"{key}.jpg"
    if out.exists():
        return out
    out.parent.mkdir(exist_ok=True)
    try:
        probe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer",
                                "-of", "csv=p=0", str(target)], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        probe = ""
    hdr = probe.split(",")[0].strip() in ("smpte2084", "arib-std-b67")
    tonemap = montaje_consts().get("TONEMAP", "") if hdr else ""
    tmp = out.with_name(f"{key}-{uuid.uuid4().hex[:6]}.jpg")
    for start in (at, 0):   # si el segundo pedido pasa del final, se usa el primer fotograma
        try:
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", str(target), "-frames:v", "1",
                            "-vf", f"{tonemap}scale={width}:-2", "-q:v", "4", str(tmp)], capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if tmp.exists() and tmp.stat().st_size:
            tmp.replace(out)
            return out
    raise ValueError("No se pudo sacar el fotograma (¿falta ffmpeg?)")


def video_config() -> dict:
    """Estilos de capa, ventanas y formatos de tools/montaje.py, sin ejecutarlo."""
    consts = montaje_consts()
    capa = consts.get("CAPA", {})
    return {
        "formatos": {k: list(v) for k, v in consts.get("SIZE", {}).items()},
        "capa": {f"{k[0]}:{k[1]}": v for k, v in capa.items()},
        "ventana": {k: list(v) for k, v in consts.get("VENTANA", {}).items()},
        "ventana_marco": [960, 540, 60, 650],   # 9x16-marco: clip horizontal dentro de marco_video
        "texto_en_marco": sorted(consts.get("TEXTO_EN_MARCO", [])),
    }


def estado() -> dict:
    """Compatibilidad con el kit: ejecuta su contrato (tools/generador.py --json)."""
    if not (BRAND / "tools").is_dir():
        return {"ok": False, "kit": str(BRAND), "errores": [f"No se encontró el kit de marca en {BRAND} (usa BRAND_REPO)"], "avisos": []}
    contrato = BRAND / "tools" / "generador.py"
    if not contrato.exists():
        return {"ok": True, "kit": str(BRAND), "errores": [], "avisos": ["El kit no tiene tools/generador.py: actualízalo para revisar la compatibilidad"]}
    result = run_python(contrato, ["--json"], BRAND, timeout=120)
    try:
        return json.loads(result.get("stdout", "").strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {"ok": False, "kit": str(BRAND), "errores": ["El contrato del kit falló: " + (result.get("stderr") or result.get("error") or "")[-600:]], "avisos": []}


class App(BaseHTTPRequestHandler):
    server_version = "GeneradorTPD/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            if url.path == "/":
                return self.static("index.html")
            if url.path.startswith("/static/"):
                return self.static(url.path.removeprefix("/static/"))
            if url.path.startswith("/marca/"):
                return self.brand_file(url.path.removeprefix("/marca/"))
            if url.path == "/api/projects":
                PROJECTS.mkdir(exist_ok=True)
                items = [project_json(p) for p in sorted(PROJECTS.iterdir()) if p.is_dir() and (p / "project.json").exists()]
                return json_response(self, {"projects": items})
            if url.path == "/api/templates":
                return json_response(self, {"templates": templates()})
            if url.path == "/api/estado":
                return json_response(self, estado())
            if url.path == "/api/video-config":
                return json_response(self, video_config())
            file_match = re.fullmatch(r"/files/([\w-]+)/(.+)", url.path)
            if file_match:
                path = project_path(file_match.group(1))
                target = (path / Path(unquote(file_match.group(2)))).resolve()
                if path.resolve() not in target.parents or not target.is_file():
                    return json_response(self, {"error": "Archivo no encontrado"}, 404)
                return self.send_file(target, download="descargar=1" in url.query)
            thumb_match = re.fullmatch(r"/thumb/([\w-]+)/(.+)", url.path)
            if thumb_match:
                path = project_path(thumb_match.group(1))
                target = (path / Path(unquote(thumb_match.group(2)))).resolve()
                if path.resolve() not in target.parents or not target.is_file():
                    return json_response(self, {"error": "Archivo no encontrado"}, 404)
                if target.suffix.lower() in IMAGE_EXTENSIONS:
                    return self.send_file(target)
                query = dict(part.split("=", 1) for part in url.query.split("&") if "=" in part)
                at = max(0.0, float(query.get("t", "0.5") or 0.5))
                width = min(1920, max(64, int(float(query.get("w", "360") or 360))))
                return self.send_file(thumbnail(path, target, at, width))
            match = re.fullmatch(r"/api/projects/([\w-]+)", url.path)
            if match:
                path = project_path(match.group(1))
                if not path.exists():
                    return json_response(self, {"error": "Proyecto no encontrado"}, 404)
                return json_response(self, project_json(path))
            return json_response(self, {"error": "Ruta no encontrada"}, 404)
        except Exception as exc:
            return json_response(self, {"error": str(exc)}, 400)

    def do_POST(self):
        url = urlsplit(self.path)
        try:
            if url.path == "/api/projects":
                data = read_json(self)
                name = str(data.get("name", "Proyecto sin nombre")).strip() or "Proyecto sin nombre"
                pid = now_id()
                path = PROJECTS / pid
                for folder in (path / "media", path / "jobs", path / "outputs"):
                    folder.mkdir(parents=True, exist_ok=True)
                (path / "project.json").write_text(json.dumps({"name": name, "notes": data.get("notes", ""), "created": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False, indent=2), encoding="utf-8")
                return json_response(self, project_json(path), 201)

            match = re.fullmatch(r"/api/projects/([\w-]+)/upload", url.path)
            if match:
                path = project_path(match.group(1))
                if not path.is_dir():
                    return json_response(self, {"error": "Proyecto no encontrado"}, 404)
                ensure_project_dirs(path)
                saved = []
                for _, filename, content in read_multipart(self):
                    target = path / "media" / filename
                    stem, suffix = target.stem, target.suffix
                    n = 2
                    while target.exists():
                        target = path / "media" / f"{stem}-{n}{suffix}"
                        n += 1
                    target.write_bytes(content)
                    saved.append(target.relative_to(path).as_posix())
                return json_response(self, {"saved": saved, "project": project_json(path)})

            match = re.fullmatch(r"/api/projects/([\w-]+)/image", url.path)
            if match:
                path = project_path(match.group(1))
                data = read_json(self)
                template = clean_name(str(data.get("template", "post_general")))
                values = data.get("values", {})
                if not isinstance(values, dict):
                    raise ValueError("values debe ser un objeto JSON")
                ensure_project_dirs(path)
                values = normalize_image_values(path, values)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                output = path / "outputs" / f"{template}-{stamp}.png"
                job = [{"template": template, "values": values, "output": str(output)}]
                job_file = path / "jobs" / f"imagen-{stamp}.json"
                job_file.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
                result = run_python(BRAND / "tools" / "render_editor.py", [str(job_file)], path)
                result.update({"job": str(job_file), "output": str(output), "download": f"/files/{path.name}/{output.relative_to(path).as_posix()}", "project": project_json(path)})
                return json_response(self, result, 200 if result.get("ok") else 500)

            match = re.fullmatch(r"/api/projects/([\w-]+)/video", url.path)
            if match:
                path = project_path(match.group(1))
                data = read_json(self)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                script = data.get("script") if isinstance(data.get("script"), dict) else {}
                script.setdefault("formato", data.get("format", "9x16-marco"))
                if not isinstance(script.get("salida"), str) or not script["salida"].strip():
                    script["salida"] = f"outputs/video-{stamp}.mp4"
                script["salida"] = project_output(path, script["salida"])
                script.setdefault("intro", bool(data.get("intro", True)))
                script.setdefault("cierre", bool(data.get("cierre", True)))
                script.setdefault("audio", data.get("audio", "original"))
                if not isinstance(script.get("segmentos"), list) or not script["segmentos"]:
                    raise ValueError("Agrega al menos un segmento")
                ensure_project_dirs(path)
                for segment in script["segmentos"]:
                    if not isinstance(segment, dict):
                        raise ValueError("Cada segmento debe ser un objeto JSON")
                    for key in ("clip", "foto"):
                        if key in segment:
                            segment[key] = project_asset(path, segment[key])
                script_file = path / "jobs" / f"video-{stamp}.json"
                script_file.write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")
                result = run_python(BRAND / "tools" / "montaje.py", [str(script_file)], path)
                output_path = Path(script["salida"]).resolve()
                result.update({"job": str(script_file), "output": str(output_path), "download": f"/files/{path.name}/{output_path.relative_to(path).as_posix()}", "project": project_json(path)})
                return json_response(self, result, 200 if result.get("ok") else 500)

            if url.path == "/api/validate":
                result = run_python(BRAND / "tools" / "validar.py", [], BRAND, timeout=1800)
                return json_response(self, result, 200 if result.get("code") in (0, 1) else 500)

            if url.path == "/api/video-kit":
                result = run_python(BRAND / "tools" / "video.py", [], BRAND, timeout=3600)
                return json_response(self, result, 200 if result.get("ok") else 500)
            return json_response(self, {"error": "Ruta no encontrada"}, 404)
        except Exception as exc:
            return json_response(self, {"error": str(exc)}, 400)

    def brand_file(self, name: str):
        name = unquote(name)
        target = (BRAND / name).resolve()
        # Se valida la ruta ya resuelta: "editor/../.git/config" no debe pasar por empezar con "editor/"
        rel = target.relative_to(BRAND).as_posix() if BRAND in target.parents else ""
        if not rel.startswith(BRAND_PUBLIC) or not target.is_file():
            return json_response(self, {"error": "Archivo no encontrado"}, 404)
        self.send_file(target)

    def static(self, name: str):
        name = unquote(name)
        target = (STATIC / name).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            return json_response(self, {"error": "Archivo no encontrado"}, 404)
        self.send_file(target)

    def send_file(self, target: Path, download: bool = False):
        size = target.stat().st_size
        start, end = 0, size - 1
        rng = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if rng and size and (rng.group(1) or rng.group(2)):
            if rng.group(1):
                start, end = int(rng.group(1)), min(int(rng.group(2) or size - 1), size - 1)
            else:
                start = max(0, size - int(rng.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        kind = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if kind.startswith("text/") or kind in ("application/javascript", "application/json", "image/svg+xml"):
            kind += "; charset=utf-8"
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if download:
            self.send_header("Content-Disposition", disposition(target.name))
        self.end_headers()
        try:
            with target.open("rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(1024 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass   # el navegador cortó la descarga (normal al adelantar un video)


def main():
    PROJECTS.mkdir(exist_ok=True)
    if not (BRAND / "tools").is_dir():
        print(f"Advertencia: no se encontró el kit en {BRAND}")
    print(f"Kit de marca: {BRAND}")
    status = estado()
    for problem in status.get("errores", []):
        print(f"ERROR: {problem}")
    for problem in status.get("avisos", []):
        print(f"Aviso: {problem}")
    url = f"http://127.0.0.1:{PORT}"
    print(f"Panel local: {url}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), App)
    if "--abrir" in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Panel detenido.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Panel local para preparar y ejecutar los generadores de Tazón para Dos."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
BRAND = Path(os.environ.get("BRAND_REPO", ROOT.parent / "tazon-para-dos-marca")).expanduser().resolve()
PROJECTS = ROOT / "projects"
STATIC = ROOT / "static"
PORT = int(os.environ.get("PORT", "8765"))
MAX_UPLOAD = 1024 * 1024 * 1024
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


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


def project_json(path: Path) -> dict:
    data = metadata(path)
    data["id"] = path.name
    data["files"] = files_in(path)
    data["paths"] = {
        "root": str(path),
        "media": str(path / "media"),
        "jobs": str(path / "jobs"),
        "outputs": str(path / "outputs"),
    }
    return data


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
        proc = subprocess.run([os.environ.get("PYTHON") or sys.executable, "-I", str(script), *args], cwd=cwd,
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
            if url.path == "/api/projects":
                PROJECTS.mkdir(exist_ok=True)
                items = [project_json(p) for p in sorted(PROJECTS.iterdir()) if p.is_dir() and (p / "project.json").exists()]
                return json_response(self, {"projects": items})
            if url.path == "/api/templates":
                return json_response(self, {"templates": templates()})
            file_match = re.fullmatch(r"/files/([\w-]+)/(.+)", url.path)
            if file_match:
                path = project_path(file_match.group(1))
                target = (path / Path(unquote(file_match.group(2)))).resolve()
                if path.resolve() not in target.parents or not target.is_file():
                    return json_response(self, {"error": "Archivo no encontrado"}, 404)
                body = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
                self.send_header("Content-Disposition", f'attachment; filename="{clean_name(target.name)}"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
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
                    saved.append(str(target.relative_to(path)))
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

            if url.path == "/api/video-kit":
                result = run_python(BRAND / "tools" / "video.py", [], BRAND, timeout=3600)
                return json_response(self, result, 200 if result.get("ok") else 500)
            return json_response(self, {"error": "Ruta no encontrada"}, 404)
        except Exception as exc:
            return json_response(self, {"error": str(exc)}, 400)

    def static(self, name: str):
        name = unquote(name)
        target = (STATIC / name).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            return json_response(self, {"error": "Archivo no encontrado"}, 404)
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    PROJECTS.mkdir(exist_ok=True)
    if not (BRAND / "tools").is_dir():
        print(f"Advertencia: no se encontró el kit en {BRAND}")
    print(f"Kit de marca: {BRAND}")
    print(f"Panel local: http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), App).serve_forever()


if __name__ == "__main__":
    main()

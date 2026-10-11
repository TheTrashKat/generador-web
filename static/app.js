const $ = (id) => document.getElementById(id);
let projects = [];
let current = null;
let templates = [];

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const type = res.headers.get("content-type") || "";
  let data;
  if (type.includes("application/json")) data = await res.json();
  else data = { error: (await res.text()).slice(0, 500) || `Error ${res.status}` };
  if (!res.ok) throw new Error(data.error || data.stderr || `Error ${res.status}`);
  return data;
}

async function runBusy(id, work, onError = (error) => alert(error.message)) {
  const button = $(id);
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.dataset.label = label;
  button.textContent = "Procesando…";
  button.classList.add("busy");
  try { return await work(); }
  catch (error) { onError(error); }
  finally {
    button.disabled = false;
    button.textContent = button.dataset.label || label;
    button.classList.remove("busy");
  }
}

function parseImageValues() {
  let values;
  try { values = JSON.parse($("image-values").value); }
  catch { throw new Error("Los valores de imagen no son JSON válido."); }
  if (!values || Array.isArray(values) || typeof values !== "object") throw new Error("Los valores deben ser un objeto JSON.");
  return values;
}

function selectedProject() {
  return projects.find((p) => p.id === $("project-select").value);
}

function bytes(n) { return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`; }

function showProject(p) {
  current = p;
  $("project-path").textContent = p ? `Ruta: ${p.paths.root}` : "";
  renderFiles();
  renderSegments();
}

function renderProjects() {
  const select = $("project-select");
  select.innerHTML = '<option value="">Selecciona un proyecto</option>' + projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} · ${p.id}</option>`).join("");
  if (current && projects.some((p) => p.id === current.id)) select.value = current.id;
}

function renderFiles() {
  const box = $("file-list");
  if (!current) { box.innerHTML = '<p class="muted">Primero selecciona un proyecto.</p>'; return; }
  box.innerHTML = current.files.length ? current.files.map((f) => {
    const href = `/files/${encodeURIComponent(current.id)}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
    return `<div class="file-row"><input class="media-check" data-path="${escapeHtml(f.path)}" type="checkbox" checked><span>${escapeHtml(f.name)}</span><small>${f.kind} · ${bytes(f.size)}</small><a href="${href}" download title="Descargar ${escapeHtml(f.name)}">↓</a></div>`;
  }).join("") : '<p class="muted">Aún no hay archivos. Carga una foto o un álbum.</p>';
  box.querySelectorAll(".media-check").forEach((x) => x.addEventListener("change", renderSegments));
}

function selectedMedia() { return [...document.querySelectorAll(".media-check:checked")].map((x) => x.dataset.path); }

function renderSegments() {
  const box = $("segments");
  if (!current) { box.innerHTML = '<p class="muted">No hay archivos cargados.</p>'; return; }
  const files = current.files.filter((f) => selectedMedia().includes(f.path));
  if (!files.length) { box.innerHTML = '<p class="muted">Marca los archivos que quieres usar en el video.</p>'; return; }
  box.innerHTML = files.map((f, i) => `<div class="segment"><input type="checkbox" class="segment-use" data-path="${escapeHtml(f.path)}" checked title="Incluir"><span title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span><label>Segundos<input class="segment-duration" data-path="${escapeHtml(f.path)}" type="number" min="0.5" step="0.5" value="4"></label><label>Encuadre<select class="segment-frame" data-path="${escapeHtml(f.path)}"><option value="centro">Centro</option><option value="izquierda">Izquierda</option><option value="derecha">Derecha</option></select></label><label>Texto<input class="segment-text" data-path="${escapeHtml(f.path)}" placeholder="Mensaje opcional"></label></div>`).join("");
}

function buildScript() {
  const segments = [...document.querySelectorAll(".segment")].filter((row) => row.querySelector(".segment-use").checked).map((row) => {
    const path = row.querySelector(".segment-use").dataset.path;
    const file = current.files.find((f) => f.path === path);
    const out = { [file.kind === "image" ? "foto" : "clip"]: path, duracion: Number(row.querySelector(".segment-duration").value) || 4, encuadre: row.querySelector(".segment-frame").value };
    const text = row.querySelector(".segment-text").value.trim();
    if (text) out.texto = text;
    return out;
  });
  const formato = $("video-format").value;
  const estilo = formato === "16x9" ? $("video-style").value : $("video-style").value;
  const capa = { estilo, titulo1: $("video-title").value, etiqueta: $("video-label").value, usuario: $("video-user").value, info: $("video-info").value, linea: $("video-line").value, fondo: $("video-background").value };
  const script = { formato, salida: "", intro: $("video-intro").checked, cierre: $("video-outro").checked, audio: $("video-audio").value, marco: { receta: "general", titulo: $("video-title").value, etiqueta: $("video-label").value, usuario: $("video-user").value }, capa, segmentos: segments };
  if (estilo === "tiktok") script.gancho = { linea1: $("video-hook1").value, linea2: $("video-hook2").value };
  return script;
}

function updateVideoStyles() {
  const format = $("video-format").value;
  const select = $("video-style");
  const currentStyle = select.value;
  const options = format === "16x9" ? [["clasico", "Clásica"], ["banda", "Banda"]] : format === "9x16-marco" ? [["clasico", "Marco clásico"]] : [["editorial", "Editorial (recomendado)"], ["zine", "Mesa / Zine"], ["clasico", "Clásica"], ["banda", "Banda"], ["stickers", "Stickers"], ["marco", "Marco"], ["tiktok", "TikTok"]];
  select.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  select.value = options.some(([value]) => value === currentStyle) ? currentStyle : options[0][0];
  $("tiktok-hook").classList.toggle("hidden", select.value !== "tiktok");
  $("video-line").disabled = select.value !== "tiktok";
}

async function refresh() {
  const data = await api("/api/projects"); projects = data.projects; renderProjects(); showProject(selectedProject());
}

async function loadTemplates() {
  const data = await api("/api/templates"); templates = data.templates;
  $("template").innerHTML = templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} · ${t.size}</option>`).join("");
}

$("create-project").onclick = async () => {
  try { const p = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("project-name").value, notes: $("project-notes").value }) }); await refresh(); $("project-select").value = p.id; showProject(p); } catch (e) { alert(e.message); }
};
$("project-select").onchange = () => showProject(selectedProject());
$("refresh").onclick = refresh;
$("video-format").onchange = updateVideoStyles;
$("video-style").onchange = updateVideoStyles;

async function uploadFiles(fileList) {
  if (!current) return alert("Selecciona primero un proyecto.");
  if (!fileList.length) return;
  const projectId = current.id;
  const form = new FormData();
  [...fileList].forEach((file) => form.append("files", file));
  try {
    await api(`/api/projects/${projectId}/upload`, { method: "POST", body: form });
    await refresh();
    $("project-select").value = projectId;
    showProject(projects.find((p) => p.id === projectId));
    $("files").value = "";
  } catch (e) { alert(e.message); }
}

$("files").onchange = (event) => uploadFiles(event.target.files);
$("dropzone").onclick = () => $("files").click();
$("files").onclick = (event) => event.stopPropagation();
$("dropzone").ondragover = (e) => { e.preventDefault(); };
$("dropzone").ondrop = (e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); };

$("make-image").onclick = async () => {
  if (!current) return alert("Selecciona un proyecto.");
  try { const values = JSON.parse($("image-values").value); const result = await api(`/api/projects/${current.id}/image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: $("template").value, values }) }); $("image-result").innerHTML = formatResult(result); await refresh(); } catch (e) { $("image-result").textContent = e.message; }
};
$("make-video").onclick = async () => {
  if (!current) return alert("Selecciona un proyecto.");
  try { const script = buildScript(); if (!script.segmentos.length) throw new Error("Selecciona al menos un segmento."); const result = await api(`/api/projects/${current.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script }) }); $("video-result").innerHTML = formatResult(result); await refresh(); } catch (e) { $("video-result").textContent = e.message; }
};
$("make-kit").onclick = async () => { $("kit-result").textContent = "Ejecutando tools/video.py..."; try { $("kit-result").innerHTML = formatResult(await api("/api/video-kit", { method: "POST" })); } catch (e) { $("kit-result").textContent = e.message; } };

function formatResult(r) { const text = `${r.ok ? "LISTO" : "ERROR"}\n${r.output ? `Salida: ${r.output}\n` : ""}${r.job ? `Job: ${r.job}\n` : ""}\n${r.stdout || ""}\n${r.stderr || r.error || ""}`; return `${escapeHtml(text)}${r.ok && r.download ? `<br><a href="${encodeURI(r.download)}" download>⬇ Descargar archivo</a>` : ""}`; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

Promise.all([refresh(), loadTemplates()]).catch((e) => alert(e.message));
updateVideoStyles();

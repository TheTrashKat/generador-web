const $ = (id) => document.getElementById(id);
let projects = [];
let current = null;
let templates = [];
// Plantillas con sus campos, leídas del editor del kit de marca (/marca/editor/templates.js)
const KIT = Array.isArray(window.TPDTemplates) ? window.TPDTemplates : null;
const outSize = (t) => t.out || { w: t.w, h: t.h };

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
  if (KIT) { renderFields(readValues()); schedulePreview(); }
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
  if (estilo === "tiktok") {
    capa.subtitulos = $("video-subs").value;
    if ($("video-hook1").value.trim() || $("video-hook2").value.trim()) script.gancho = { linea1: $("video-hook1").value, linea2: $("video-hook2").value };
  }
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
  if (KIT) {
    templates = KIT.filter((t) => t.id !== "guia_zonas");
    const groups = {};
    templates.forEach((t) => (groups[t.group] = groups[t.group] || []).push(t));
    $("template").innerHTML = Object.entries(groups).map(([g, ts]) => `<optgroup label="${escapeHtml(g)}">` +
      ts.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} · ${outSize(t).w}×${outSize(t).h}</option>`).join("") + "</optgroup>").join("");
    selectTemplate();
    return;
  }
  // Sin acceso al editor del kit: lista básica y valores en JSON
  const data = await api("/api/templates"); templates = data.templates;
  $("template").innerHTML = templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} · ${t.size}</option>`).join("");
  $("image-fields").innerHTML = '<p class="muted">No se pudo cargar el editor del kit de marca: escribe los valores en JSON.</p>';
  document.querySelector(".advanced").open = true;
}

// ---- Formulario de la plantilla (campos de editor/templates.js) y vista previa
const kitTemplate = () => KIT && KIT.find((t) => t.id === $("template").value);
const defaultsOf = (t) => Object.fromEntries(t.fields.map((f) => [f.key, f.default ?? ""]));
const projectImages = () => (current ? current.files.filter((f) => f.kind === "image") : []);

function readValues() {
  try { const v = JSON.parse($("image-values").value); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

function renderFields(values) {
  const t = kitTemplate();
  if (!t) return;
  $("image-fields").innerHTML = t.fields.map((f) => {
    const id = `fld-${f.key}`, v = values[f.key] ?? f.default ?? "", label = escapeHtml(f.label);
    if (f.type === "checkbox") return `<label class="check"><input type="checkbox" id="${id}" data-key="${f.key}"${v ? " checked" : ""}> ${label}</label>`;
    if (f.type === "textarea") return `<label class="wide">${label}<textarea id="${id}" data-key="${f.key}" rows="3">${escapeHtml(v)}</textarea></label>`;
    if (f.type === "select") return `<label>${label}<select id="${id}" data-key="${f.key}">${f.options.map(([o, l]) => `<option value="${escapeHtml(o)}"${String(o) === String(v) ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select></label>`;
    if (f.type === "image") {
      const imgs = projectImages();
      const note = current ? (imgs.length ? "" : " (sube fotos en 02)") : " (elige un proyecto)";
      return `<label class="wide">${label}${note}<select id="${id}" data-key="${f.key}"><option value="">Sin foto</option>${imgs.map((i) => `<option value="${escapeHtml(i.path)}"${i.path === v ? " selected" : ""}>${escapeHtml(i.name)}</option>`).join("")}</select></label>`;
    }
    return `<label>${label}<input id="${id}" data-key="${f.key}" type="${f.type === "number" ? "number" : "text"}" value="${escapeHtml(v)}"></label>`;
  }).join("") || '<p class="muted">Esta plantilla no tiene campos editables.</p>';
  syncJSON();
}

function formValues() {
  const values = {};
  $("image-fields").querySelectorAll("[data-key]").forEach((el) => {
    values[el.dataset.key] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  });
  return values;
}

function syncJSON() { $("image-values").value = JSON.stringify(formValues(), null, 2); }

function selectTemplate() {
  const t = kitTemplate();
  if (!t) return;
  renderFields(defaultsOf(t));
  const o = outSize(t);
  $("preview-size").textContent = `${t.id} · ${o.w}×${o.h} px${t.transparent ? " · capa transparente para video" : ""}`;
  schedulePreview();
}

function b64url(text) {
  let bin = ""; new TextEncoder().encode(text).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let previewTimer = 0;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350); }

function renderPreview() {
  const t = kitTemplate();
  if (!t) return;
  const values = readValues();
  // Las fotos del proyecto se ven en la vista previa desde /files/<proyecto>/media/...
  for (const [k, v] of Object.entries(values)) {
    if (current && typeof v === "string" && /^(\.\/)?media\//.test(v)) values[k] = `/files/${encodeURIComponent(current.id)}/${v.replace(/^\.\//, "").split("/").map(encodeURIComponent).join("/")}`;
  }
  const o = outSize(t), box = $("preview"), k = box.clientWidth / o.w;
  box.classList.toggle("alpha", !!t.transparent);
  box.style.height = `${Math.round(o.h * k)}px`;
  box.innerHTML = `<iframe title="Vista previa" scrolling="no" width="${o.w}" height="${o.h}" style="transform:scale(${k})" src="/marca/editor/index.html?embed=1&t=${encodeURIComponent(t.id)}&d=${b64url(JSON.stringify(values))}"></iframe>`;
}

$("create-project").onclick = async () => {
  try { const p = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("project-name").value, notes: $("project-notes").value }) }); await refresh(); $("project-select").value = p.id; showProject(p); } catch (e) { alert(e.message); }
};
$("project-select").onchange = () => showProject(selectedProject());
$("refresh").onclick = refresh;
$("video-format").onchange = updateVideoStyles;
$("video-style").onchange = updateVideoStyles;
$("template").onchange = () => (KIT ? selectTemplate() : null);
$("image-fields").addEventListener("input", () => { syncJSON(); schedulePreview(); });
$("image-fields").addEventListener("change", () => { syncJSON(); schedulePreview(); });
$("image-values").addEventListener("change", () => { if (KIT) { renderFields(readValues()); schedulePreview(); } });
window.addEventListener("resize", schedulePreview);

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
  try { const values = parseImageValues(); const result = await api(`/api/projects/${current.id}/image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: $("template").value, values }) }); $("image-result").innerHTML = formatResult(result); await refresh(); } catch (e) { $("image-result").textContent = e.message; }
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

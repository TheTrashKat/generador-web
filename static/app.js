const $ = (id) => document.getElementById(id);
let projects = [];
let current = null;
let templates = [];
// Plantillas con sus campos, leídas del editor del kit de marca (/marca/editor/templates.js)
const KIT = Array.isArray(window.TPDTemplates) ? window.TPDTemplates : null;
const outSize = (t) => t.out || { w: t.w, h: t.h };
// Estilos de capa de tools/montaje.py (se piden al servidor; esto es solo por si falla)
let VCFG = {
  formatos: { "9x16-marco": [1080, 1920], "9x16": [1080, 1920], "16x9": [1920, 1080] },
  capa: { "v:clasico": "overlay_reel", "v:banda": "overlay_reel_banda", "v:stickers": "overlay_reel_stickers", "v:marco": "marco_vertical",
    "v:editorial": "editorial_marco_v", "v:zine": "zine_marco_v", "v:tiktok": "overlay_tiktok", "h:clasico": "overlay_video_h", "h:banda": "overlay_video_h_banda" },
  ventana: { marco: [960, 1000, 60, 400], editorial: [984, 860, 48, 250], zine: [880, 780, 100, 280] },
  ventana_marco: [960, 540, 60, 650], texto_en_marco: ["editorial", "zine"],
};
const STYLE_ORDER = ["editorial", "zine", "tiktok", "clasico", "banda", "stickers", "marco"];
const STYLE_LABEL = { editorial: "Editorial (línea oficial)", zine: "Mesa / Zine (línea oficial)", tiktok: "TikTok (pantalla completa)", clasico: "Clásica", banda: "Banda", stickers: "Stickers", marco: "Marco" };
const STYLE_HINT = {
  editorial: "El clip va en una ventana sobre crema; el texto de cada segmento se vuelve el titular. Intro y cierre Editorial.",
  zine: "El clip va en una tarjeta de cuaderno con cinta; el texto de cada segmento es el segundo recorte. Cierre Mesa / Zine.",
  tiktok: "Clips a pantalla completa con acercamiento lento y subtítulos de 1 a 3 palabras. Recomendado: segmentos de 2 a 3 s y sin intro.",
  clasico: "Clip a pantalla completa con cabecera, información y usuario. El texto del segmento sale abajo en una caja.",
  banda: "Clip a pantalla completa con una banda de color de marca.", stickers: "Clip a pantalla completa con stickers de marca.",
  marco: "El clip va en una ventana con marco de color y sticker.",
};
const FRAME_X = { "0": 0, izquierda: 0.12, centro: 0.5, derecha: 0.88, "1": 1 };
const FRAMES = [["0", "Extremo izquierdo"], ["izquierda", "Izquierda"], ["centro", "Centro"], ["derecha", "Derecha"], ["1", "Extremo derecho"]];

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const type = res.headers.get("content-type") || "";
  let data;
  if (type.includes("application/json")) data = await res.json();
  else data = { error: (await res.text()).slice(0, 500) || `Error ${res.status}` };
  if (!res.ok && !("ok" in data)) throw new Error(data.error || data.stderr || `Error ${res.status}`);
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
// Fotograma de un video (lo saca el servidor con ffmpeg: funciona también con videos HDR/HEVC de celular)
const thumbURL = (path, t = 0.5, w = 360) => current ? `/thumb/${encodeURIComponent(current.id)}/${path.split("/").map(encodeURIComponent).join("/")}?t=${Number(t).toFixed(2)}&w=${w}` : "";
const fileURL = (path, download = false) => current ? `/files/${encodeURIComponent(current.id)}/${path.split("/").map(encodeURIComponent).join("/")}${download ? "?descargar=1" : ""}` : "";

function showProject(p) {
  const changed = (current && current.id) !== (p && p.id);
  current = p;
  if (changed) { segState = []; excluded = new Set(); }
  $("project-path").textContent = p ? `Ruta: ${p.paths.root}` : "";
  renderFiles();
  syncSegments();
  renderOutputs();
  if (KIT) { renderFields(readValues()); schedulePreview(); }
}

function renderProjects() {
  const select = $("project-select");
  select.innerHTML = '<option value="">Selecciona un proyecto</option>' + projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} · ${p.id}</option>`).join("");
  if (current && projects.some((p) => p.id === current.id)) select.value = current.id;
}

// ---- 02 · Archivos: la casilla decide si el archivo entra al video
let excluded = new Set();
function renderFiles() {
  const box = $("file-list");
  if (!current) { box.innerHTML = '<p class="muted">Primero selecciona un proyecto.</p>'; return; }
  box.innerHTML = current.files.length ? current.files.map((f) =>
    `<div class="file-row"><input class="media-check" data-path="${escapeHtml(f.path)}" type="checkbox" title="Usar en el video"${excluded.has(f.path) ? "" : " checked"}><span>${escapeHtml(f.name)}</span><small>${f.kind === "video" ? "video" : "foto"} · ${bytes(f.size)}</small><a href="${fileURL(f.path, true)}" download title="Descargar ${escapeHtml(f.name)}">↓</a></div>`).join("")
    : '<p class="muted">Aún no hay archivos. Carga una foto o un álbum.</p>';
  box.querySelectorAll(".media-check").forEach((x) => x.addEventListener("change", () => {
    if (x.checked) excluded.delete(x.dataset.path); else excluded.add(x.dataset.path);
    syncSegments();
  }));
}

// ---- 05 · Resultados
function renderOutputs() {
  const box = $("output-list");
  if (!current) { box.innerHTML = '<p class="muted">Primero selecciona un proyecto.</p>'; return; }
  const outs = current.outputs || [];
  box.innerHTML = outs.length ? outs.map((o) => {
    const media = o.kind === "video" ? `<video src="${fileURL(o.path)}" poster="${thumbURL(o.path, 1, 360)}" preload="none" controls playsinline></video>` : `<img src="${fileURL(o.path)}" alt="" loading="lazy">`;
    return `<div class="out-card">${media}<div>${escapeHtml(o.name)}<br><span class="muted">${escapeHtml(o.time)} · ${bytes(o.size)}</span><br><a href="${fileURL(o.path)}" target="_blank" rel="noopener">Abrir</a><a href="${fileURL(o.path, true)}" download>Descargar</a></div></div>`;
  }).join("") : '<p class="muted">Todavía no hay resultados en este proyecto.</p>';
}

// ---- 04 · Video: segmentos (fotos/videos marcados + separadores), en el orden que elijas
let segState = [];
const isTikTok = () => $("video-format").value === "9x16" && $("video-style").value === "tiktok";

function syncSegments() {
  if (!current) { segState = []; renderSegments(); return; }
  const chosen = current.files.filter((f) => !excluded.has(f.path));
  segState = segState.filter((s) => s.type === "sep" || chosen.some((f) => f.path === s.path));
  for (const f of chosen) {
    if (!segState.some((s) => s.path === f.path)) segState.push({ type: "media", path: f.path, kind: f.kind, name: f.name, duracion: isTikTok() ? 3 : 4, inicio: 0, encuadre: "centro", texto: "", numero: "", titulo: "" });
  }
  renderSegments();
}

function renderSegments() {
  const box = $("segments");
  if (!current) { box.innerHTML = '<p class="muted">No hay archivos cargados.</p>'; updateTotal(); return; }
  if (!segState.length) { box.innerHTML = '<p class="muted">Marca en 02 las fotos o videos que quieres usar.</p>'; updateTotal(); videoPreviewSoon(); return; }
  const list = isTikTok() && $("video-list").checked;
  const num = (k, s, label, step = 0.5, min = 0) => `<label>${label}<input type="number" data-k="${k}" min="${min}" step="${step}" value="${escapeHtml(s[k])}"></label>`;
  const txt = (k, s, label, ph = "", wide = false) => `<label${wide ? ' class="wide"' : ""}>${label}<input data-k="${k}" value="${escapeHtml(s[k])}" placeholder="${escapeHtml(ph)}"></label>`;
  box.innerHTML = segState.map((s, i) => {
    const moves = `<button class="icon-btn" data-move="-1" title="Subir"${i ? "" : " disabled"}>↑</button><button class="icon-btn" data-move="1" title="Bajar"${i < segState.length - 1 ? "" : " disabled"}>↓</button>`;
    if (s.type === "sep") {
      return `<div class="segment sep" data-i="${i}"><div class="seg-head">${moves}<span class="seg-thumb sep">§</span><strong>Separador (tarjeta de capítulo)</strong><button class="icon-btn" data-remove title="Quitar separador">✕</button></div>
        <div class="seg-fields">${txt("numero", s, "Número", "02")}${txt("titulo", s, "Título", "LA GRABACIÓN.", true)}${txt("subtitulo", s, "Subtítulo", "Opcional", true)}${num("duracion", s, "Segundos", 0.5, 1)}</div></div>`;
    }
    const thumb = `<img class="seg-thumb" src="${s.kind === "video" ? thumbURL(s.path, (Number(s.inicio) || 0) + 0.3, 120) : fileURL(s.path)}" alt="">`;
    return `<div class="segment" data-i="${i}"><div class="seg-head">${moves}${thumb}<strong title="${escapeHtml(s.path)}">${escapeHtml(s.name)}</strong><button class="icon-btn" data-remove title="No usar en el video">✕</button></div>
      <div class="seg-fields">${s.kind === "video" ? num("inicio", s, "Desde (s)") : ""}${num("duracion", s, "Segundos", 0.5, 0.5)}
        <label>Encuadre<select data-k="encuadre">${FRAMES.map(([v, l]) => `<option value="${v}"${s.encuadre === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        ${txt("texto", s, isTikTok() ? "Subtítulo" : "Texto", "Mensaje opcional", true)}${list ? txt("numero", s, "Nº de lista", "3") + txt("titulo", s, "Título de lista", "CATAN") : ""}</div></div>`;
  }).join("");
  updateTotal();
  videoPreviewSoon();
}

$("segments").addEventListener("input", (e) => {
  const row = e.target.closest(".segment"), k = e.target.dataset.k;
  if (!row || !k) return;
  const s = segState[Number(row.dataset.i)];
  s[k] = e.target.type === "number" ? Number(e.target.value) : e.target.value;
  updateTotal();
  videoPreviewSoon();
});
$("segments").addEventListener("click", (e) => {
  const row = e.target.closest(".segment");
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.dataset.move) {
    const j = i + Number(e.target.dataset.move);
    if (j < 0 || j >= segState.length) return;
    [segState[i], segState[j]] = [segState[j], segState[i]];
    renderSegments();
  } else if ("remove" in e.target.dataset) {
    const s = segState[i];
    if (s.type === "sep") segState.splice(i, 1);
    else { excluded.add(s.path); renderFiles(); segState.splice(i, 1); }
    renderSegments();
  }
});
$("add-separator").onclick = () => {
  if (!current) return alert("Selecciona un proyecto.");
  const n = segState.filter((s) => s.type === "sep").length + 1;
  segState.push({ type: "sep", numero: String(n).padStart(2, "0"), titulo: "", subtitulo: "", duracion: 2.5 });
  renderSegments();
};

function updateTotal() {
  const used = segState.reduce((a, s) => a + (Number(s.duracion) || 0), 0);
  if (!used) { $("video-total").textContent = ""; return; }
  const vertical = $("video-format").value !== "16x9";
  const total = used + ($("video-intro").checked ? 2.5 : 0) + ($("video-outro").checked ? 4 : 0);
  const tip = vertical ? (total > 30 ? " · para Reels conviene 15 a 30 s" : total < 10 ? " · un poco corto" : " · buena duración para Reels") : "";
  $("video-total").textContent = `Duración aproximada: ${total.toFixed(1)} s${tip}`;
}

// ---- 04 · Video: capa de marca (campos de la plantilla del estilo elegido)
const capaValues = {};
function capaTemplateId() {
  const fmt = $("video-format").value;
  if (fmt === "9x16-marco") return "marco_video";
  return VCFG.capa[`${fmt === "16x9" ? "h" : "v"}:${$("video-style").value}`];
}
const capaSkip = (tid) => (tid === "marco_video" ? ["texto"] : []);   // lo pone cada segmento

function updateVideoStyles() {
  const fmt = $("video-format").value, select = $("video-style"), prev = select.value;
  let styles;
  if (fmt === "9x16-marco") styles = [["clasico", "Marco con receta de color"]];
  else {
    const pre = fmt === "16x9" ? "h:" : "v:";
    const found = Object.keys(VCFG.capa).filter((k) => k.startsWith(pre)).map((k) => k.slice(2));
    styles = found.sort((a, b) => (STYLE_ORDER.indexOf(a) + 99) % 99 - (STYLE_ORDER.indexOf(b) + 99) % 99).map((s) => [s, STYLE_LABEL[s] || s]);
  }
  select.innerHTML = styles.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join("");
  select.value = styles.some(([v]) => v === prev) ? prev : styles[0][0];
  onStyleChange();
}

let wasTikTok = false;
function onStyleChange() {
  const style = $("video-style").value, tiktok = isTikTok(), entering = tiktok && !wasTikTok;
  wasTikTok = tiktok;
  $("tiktok-box").classList.toggle("hidden", !tiktok);
  $("style-hint").textContent = $("video-format").value === "9x16-marco" ? "Para clips horizontales: el clip va entero en el centro, con título arriba y el texto de cada segmento abajo." : STYLE_HINT[style] || "";
  if (entering) {   // recomendaciones TikTok: sin intro y segmentos cortos
    $("video-intro").checked = false;
    segState.forEach((s) => { if (s.type === "media" && s.duracion === 4) s.duracion = 3; });
  }
  renderCapaFields();
  renderSegments();
}

function renderCapaFields() {
  const tid = capaTemplateId(), t = KIT && KIT.find((x) => x.id === tid);
  const box = $("capa-fields");
  if (!t) { box.innerHTML = '<p class="muted">No se encontró la plantilla de la capa en el kit.</p>'; return; }
  const vals = (capaValues[tid] = capaValues[tid] || defaultsOf(t));
  box.innerHTML = t.fields.filter((f) => !capaSkip(tid).includes(f.key)).map((f) => fieldHTML(f, vals[f.key], `cap-${f.key}`)).join("");
  videoPreviewSoon();
}
$("capa-fields").addEventListener("input", readCapa);
$("capa-fields").addEventListener("change", readCapa);
function readCapa() {
  const tid = capaTemplateId();
  $("capa-fields").querySelectorAll("[data-key]").forEach((el) => { capaValues[tid][el.dataset.key] = valueOf(el); });
  videoPreviewSoon();
}

function buildScript() {
  const formato = $("video-format").value, estilo = $("video-style").value, tiktok = isTikTok(), list = tiktok && $("video-list").checked;
  const tid = capaTemplateId(), vals = { ...(capaValues[tid] || {}) };
  capaSkip(tid).forEach((k) => delete vals[k]);
  const receta = vals.receta || "general";
  const segmentos = segState.map((s) => {
    if (s.type === "sep") {
      const sep = { receta, titulo: s.titulo || " " };
      if (s.numero) sep.numero = s.numero;
      if (s.subtitulo) sep.subtitulo = s.subtitulo;
      return { separador: sep, duracion: Number(s.duracion) || 2.5 };
    }
    const out = { [s.kind === "image" ? "foto" : "clip"]: s.path, duracion: Number(s.duracion) || 4, encuadre: s.encuadre };
    if (s.kind === "video" && Number(s.inicio) > 0) out.inicio = Number(s.inicio);
    if (s.texto.trim()) out.texto = s.texto.trim();
    if (list && String(s.numero).trim()) { out.numero = String(s.numero).trim(); out.titulo = String(s.titulo || "").trim(); }
    return out;
  });
  const script = { formato, salida: "", intro: $("video-intro").checked, cierre: $("video-outro").checked, audio: $("video-audio").value, segmentos };
  if (formato === "9x16-marco") { script.marco = vals; script.capa = { estilo: "clasico" }; }
  else script.capa = { estilo, ...vals };
  if (tiktok) {
    script.capa.subtitulos = $("video-subs").value;
    script.capa.linea = $("video-line").value;
    if ($("video-hook1").value.trim() || $("video-hook2").value.trim()) script.gancho = { linea1: $("video-hook1").value.trim(), linea2: $("video-hook2").value.trim() };
  }
  return script;
}

// ---- 04 · Video: vista previa del primer segmento (foto/video + capas del kit superpuestas)
function chunks(text, maxWords = 3, maxChars = 16) {   // igual que chunks() de tools/montaje.py
  const out = []; let cur = [];
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (cur.length && (cur.length >= maxWords || [...cur, w].join(" ").length > maxChars)) { out.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}
const layerSrc = (tid, values) => `/marca/editor/index.html?embed=1&t=${encodeURIComponent(tid)}&d=${b64url(JSON.stringify(values))}`;
let videoTimer = 0;
function videoPreviewSoon() { clearTimeout(videoTimer); videoTimer = setTimeout(renderVideoPreview, 400); }

function renderVideoPreview() {
  const box = $("video-preview"), note = $("video-preview-note");
  const fmt = $("video-format").value, style = $("video-style").value, tiktok = isTikTok();
  const [W, H] = VCFG.formatos[fmt] || [1080, 1920];
  const k = box.clientWidth / W;
  box.style.height = `${Math.round(H * k)}px`;
  const seg = segState.find((s) => s.type === "media");
  if (!KIT) { box.innerHTML = '<p class="muted">Sin acceso al editor del kit.</p>'; return; }
  const tid = capaTemplateId(), vals = { ...(capaValues[tid] || {}) };
  const texto = seg ? seg.texto.trim() : "";
  const layers = [];
  // ventana del clip, igual que en el montaje
  let win = [0, 0, W, H];
  if (fmt === "9x16" && VCFG.ventana[style]) { const [w, h, x, y] = VCFG.ventana[style]; win = [x, y, w, h]; }
  if (fmt === "9x16-marco") { const [w, h, x, y] = VCFG.ventana_marco; win = [x, y, w, h]; }
  let media = "";
  if (seg) {
    const pos = `${Math.round((FRAME_X[seg.encuadre] ?? 0.5) * 100)}% 50%`;
    const css = `left:${win[0] * k}px;top:${win[1] * k}px;width:${win[2] * k}px;height:${win[3] * k}px;object-position:${pos}`;
    media = `<img class="layer-media" style="${css}" src="${seg.kind === "video" ? thumbURL(seg.path, (Number(seg.inicio) || 0) + 0.3, 1080) : fileURL(seg.path)}" alt="">`;
  }
  if (fmt === "9x16-marco") layers.push(layerSrc("marco_video", { ...vals, texto }));
  else if (VCFG.texto_en_marco.includes(style) && fmt === "9x16") layers.push(layerSrc(tid, texto ? { ...vals, titulo2: texto } : vals));
  else {
    layers.push(layerSrc(tid, vals));
    if (tiktok) {
      const sub = $("video-subs").value, first = texto ? chunks(texto, sub === "pop" ? 1 : 3)[0] : null;
      const hook = { linea1: $("video-hook1").value.trim(), linea2: $("video-hook2").value.trim() };
      if (first) layers.push(layerSrc("subtitulo_tiktok", { texto: first.join(" "), destacar: 1, estilo: sub, color: 0, ...(sub === "editorial" ? { y: 1300 } : {}) }));
      if (hook.linea1 || hook.linea2) layers.push(layerSrc("gancho_tiktok", hook));
      else if ($("video-list").checked && seg && String(seg.numero).trim()) layers.push(layerSrc("numero_tiktok", { numero: seg.numero, titulo: seg.titulo }));
    } else if (texto) layers.push(layerSrc(fmt === "16x9" ? "texto_pantalla_h" : "texto_pantalla", { texto, caja: "tinta", pos: "abajo" }));
  }
  box.innerHTML = media + layers.map((src) => `<iframe class="layer" title="Capa" scrolling="no" width="${W}" height="${H}" style="transform:scale(${k})" src="${src}"></iframe>`).join("");
  note.textContent = seg ? `${seg.name}${tiktok ? " · el gancho dura 1,8 s y luego aparecen los subtítulos" : ""}` : "Marca en 02 al menos una foto o un video.";
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

// ---- 03 · Imagen: formulario de la plantilla (campos de editor/templates.js) y vista previa
const kitTemplate = () => KIT && KIT.find((t) => t.id === $("template").value);
const defaultsOf = (t) => Object.fromEntries(t.fields.map((f) => [f.key, f.default ?? ""]));
const projectImages = () => (current ? current.files.filter((f) => f.kind === "image") : []);
const valueOf = (el) => (el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value);

function readValues() {
  try { const v = JSON.parse($("image-values").value); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

function fieldHTML(f, value, id) {
  const v = value ?? f.default ?? "", label = escapeHtml(f.label);
  if (f.type === "checkbox") return `<label class="check"><input type="checkbox" id="${id}" data-key="${f.key}"${v ? " checked" : ""}> ${label}</label>`;
  if (f.type === "textarea") return `<label class="wide">${label}<textarea id="${id}" data-key="${f.key}" rows="3">${escapeHtml(v)}</textarea></label>`;
  if (f.type === "select") return `<label>${label}<select id="${id}" data-key="${f.key}">${f.options.map(([o, l]) => `<option value="${escapeHtml(o)}"${String(o) === String(v) ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select></label>`;
  if (f.type === "image") {
    // Selector visual: miniaturas de las fotos del proyecto + botón para subir una aquí mismo
    const imgs = projectImages();
    const thumbs = imgs.map((i) => `<button type="button" class="photo-pick${i.path === v ? " on" : ""}" data-pick="${f.key}" data-path="${escapeHtml(i.path)}" title="${escapeHtml(i.name)}" aria-pressed="${i.path === v}"><img src="${fileURL(i.path)}" alt="${escapeHtml(i.name)}" loading="lazy"></button>`).join("");
    const empty = !current ? '<p class="muted small">Primero elige o crea un proyecto en 01.</p>' : imgs.length ? "" : '<p class="muted small">Aún no hay fotos en el proyecto: súbela aquí.</p>';
    return `<div class="wide photo-field"><span class="photo-label">${label}${v ? "" : ' <em class="missing">· falta elegir la foto</em>'}</span>` +
      `<select id="${id}" data-key="${f.key}" hidden><option value="">Sin foto</option>${imgs.map((i) => `<option value="${escapeHtml(i.path)}"${i.path === v ? " selected" : ""}>${escapeHtml(i.name)}</option>`).join("")}</select>` +
      `${empty}<div class="photo-picks">${thumbs}<label class="photo-add"${current ? "" : " hidden"}>＋ Subir foto<input type="file" accept="image/jpeg,image/png,image/webp" data-upload-for="${f.key}" hidden></label></div></div>`;
  }
  return `<label>${label}<input id="${id}" data-key="${f.key}" type="${f.type === "number" ? "number" : "text"}" value="${escapeHtml(v)}"></label>`;
}

function renderFields(values) {
  const t = kitTemplate();
  if (!t) return;
  // Los campos de foto vacíos toman las fotos del proyecto en orden (foto1, foto2…), sin repetir
  const imgs = projectImages().map((i) => i.path), used = new Set(Object.values(values));
  values = { ...values };
  t.fields.filter((f) => f.type === "image").forEach((f) => {
    if (values[f.key] && imgs.includes(values[f.key])) return;
    values[f.key] = imgs.find((path) => !used.has(path)) || "";
    used.add(values[f.key]);
  });
  $("image-fields").innerHTML = t.fields.map((f) => fieldHTML(f, values[f.key], `fld-${f.key}`)).join("") || '<p class="muted">Esta plantilla no tiene campos editables.</p>';
  syncJSON();
}

function formValues() {
  const values = {};
  $("image-fields").querySelectorAll("[data-key]").forEach((el) => { values[el.dataset.key] = valueOf(el); });
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
    if (current && typeof v === "string" && /^(\.\/)?media\//.test(v)) values[k] = fileURL(v.replace(/^\.\//, ""));
  }
  const o = outSize(t), box = $("preview"), k = box.clientWidth / o.w;
  box.classList.toggle("alpha", !!t.transparent);
  box.style.height = `${Math.round(o.h * k)}px`;
  box.innerHTML = `<iframe title="Vista previa" scrolling="no" width="${o.w}" height="${o.h}" style="transform:scale(${k})" src="${layerSrc(t.id, values)}"></iframe>`;
}

$("create-project").onclick = async () => {
  try { const p = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("project-name").value, notes: $("project-notes").value }) }); await refresh(); $("project-select").value = p.id; showProject(p); } catch (e) { alert(e.message); }
};
$("project-select").onchange = () => showProject(selectedProject());
$("refresh").onclick = refresh;
$("video-format").onchange = updateVideoStyles;
$("video-style").onchange = onStyleChange;
["video-hook1", "video-hook2"].forEach((id) => $(id).addEventListener("input", videoPreviewSoon));
$("video-subs").addEventListener("change", videoPreviewSoon);
$("video-list").addEventListener("change", renderSegments);
["video-intro", "video-outro"].forEach((id) => $(id).addEventListener("change", updateTotal));
$("template").onchange = () => (KIT ? selectTemplate() : null);
$("image-fields").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-pick]");
  if (!pick) return;
  const values = formValues(); values[pick.dataset.pick] = pick.dataset.path;
  renderFields(values); schedulePreview();
});
$("image-fields").addEventListener("change", async (e) => {
  const input = e.target.closest("[data-upload-for]");
  if (!input || !input.files.length || !current) return;
  const key = input.dataset.uploadFor, projectId = current.id, values = formValues();
  const form = new FormData(); form.append("files", input.files[0]);
  input.parentElement.firstChild.textContent = "Subiendo… ";
  try {
    const r = await api(`/api/projects/${projectId}/upload`, { method: "POST", body: form });
    await refresh(); $("project-select").value = projectId; showProject(projects.find((p) => p.id === projectId));
    values[key] = r.saved[0]; renderFields(values); schedulePreview();
  } catch (err) { $("image-result").textContent = err.message; renderFields(values); }
});
$("image-fields").addEventListener("input", () => { syncJSON(); schedulePreview(); });
$("image-fields").addEventListener("change", () => { syncJSON(); schedulePreview(); });
$("image-values").addEventListener("change", () => { if (KIT) { renderFields(readValues()); schedulePreview(); } });
window.addEventListener("resize", () => { schedulePreview(); videoPreviewSoon(); });

async function uploadFiles(fileList) {
  if (!current) return alert("Selecciona primero un proyecto.");
  if (!fileList.length) return;
  const projectId = current.id;
  const form = new FormData();
  [...fileList].forEach((file) => form.append("files", file));
  $("file-list").insertAdjacentHTML("afterbegin", `<p class="muted" id="uploading">Subiendo ${fileList.length} archivo(s)…</p>`);
  try {
    await api(`/api/projects/${projectId}/upload`, { method: "POST", body: form });
    await refresh();
    $("project-select").value = projectId;
    showProject(projects.find((p) => p.id === projectId));
    $("files").value = "";
  } catch (e) { alert(e.message); }
  finally { $("uploading")?.remove(); }
}

$("files").onchange = (event) => uploadFiles(event.target.files);
$("dropzone").onclick = () => $("files").click();
$("files").onclick = (event) => event.stopPropagation();
$("dropzone").ondragover = (e) => { e.preventDefault(); };
$("dropzone").ondrop = (e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); };

$("make-image").onclick = () => runBusy("make-image", async () => {
  if (!current) throw new Error("Selecciona un proyecto.");
  const t = kitTemplate(), vals = parseImageValues();
  const missing = t ? t.fields.filter((f) => f.type === "image" && !vals[f.key]).map((f) => f.label) : [];
  if (missing.length) throw new Error(`Falta elegir: ${missing.join(", ")}. Toca una miniatura o usa «＋ Subir foto».`);
  $("image-result").textContent = "Generando imagen…";
  const result = await api(`/api/projects/${current.id}/image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: $("template").value, values: parseImageValues() }) });
  $("image-result").innerHTML = formatResult(result, "image"); $("image-result").classList.toggle("done", !!result.ok);
  await refresh();
}, (e) => { $("image-result").classList.remove("done"); $("image-result").textContent = e.message; });

$("make-video").onclick = () => runBusy("make-video", async () => {
  if (!current) throw new Error("Selecciona un proyecto.");
  const script = buildScript();
  if (!script.segmentos.some((s) => s.clip || s.foto)) throw new Error("Marca al menos una foto o un video en 02.");
  $("video-result").classList.remove("done");
  $("video-result").textContent = "Armando el video… (puede tardar uno o dos minutos)";
  const result = await api(`/api/projects/${current.id}/video`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script }) });
  $("video-result").innerHTML = formatResult(result, "video"); $("video-result").classList.toggle("done", !!result.ok);
  await refresh();
}, (e) => { $("video-result").classList.remove("done"); $("video-result").textContent = e.message; });

$("validate").onclick = () => runBusy("validate", async () => {
  $("kit-result").classList.remove("done");
  $("kit-result").textContent = "Validando todas las plantillas (normal y con textos largos)… tarda unos minutos.";
  const r = await api("/api/validate", { method: "POST" });
  const summary = (r.stdout || "").trim().split("\n").slice(-6).join("\n");
  $("kit-result").textContent = `${r.ok ? "VALIDACIÓN OK · 0 errores" : "HAY ERRORES EN LAS PLANTILLAS"}\n\n${summary}\n${r.stderr || r.error || ""}`;
}, (e) => { $("kit-result").textContent = e.message; });

$("make-kit").onclick = () => runBusy("make-kit", async () => {
  $("kit-result").classList.remove("done");
  $("kit-result").textContent = "Ejecutando tools/video.py…";
  $("kit-result").innerHTML = formatResult(await api("/api/video-kit", { method: "POST" }));
}, (e) => { $("kit-result").textContent = e.message; });

function formatResult(r, kind = "") {
  const log = `${r.job ? `Job: ${r.job}\n` : ""}${r.stdout || ""}\n${r.stderr || r.error || ""}`.trim();
  if (!r.ok) return escapeHtml(`ERROR\n${log}`);
  const url = r.download ? encodeURI(r.download) : "";
  const poster = r.output && current ? thumbURL(`outputs/${r.output.split(/[\\/]/).pop()}`, 1, 540) : "";
  const media = !url ? "" : kind === "video" ? `<video class="media-out" src="${url}" poster="${poster}" controls playsinline></video>` : kind === "image" ? `<img class="media-out" src="${url}?v=${Date.now()}" alt="Resultado">` : "";
  return `<p class="ok">✔ Listo</p>${media}${url ? `<div class="links"><a href="${url}" target="_blank" rel="noopener">Abrir en otra pestaña</a><a href="${url}?descargar=1" download>⬇ Descargar</a></div>` : ""}<details><summary>Detalles</summary><pre>${escapeHtml(log)}</pre></details>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Compatibilidad con el kit de marca (tools/generador.py): avisa si el kit cambió de forma que rompa el panel
api("/api/estado").then((st) => {
  const problems = [...(st.errores || []), ...(st.avisos || [])];
  if (!problems.length) return;
  const box = $("kit-status");
  box.classList.toggle("error", !st.ok);
  box.innerHTML = `${st.ok ? "Avisos del kit de marca" : "El kit de marca no es compatible con el panel"}<ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`;
  box.hidden = false;
}).catch(() => {});

api("/api/video-config").then((cfg) => { if (cfg && Object.keys(cfg.capa || {}).length) VCFG = cfg; }).catch(() => {}).finally(() => {
  updateVideoStyles();
  Promise.all([refresh(), loadTemplates()]).catch((e) => alert(e.message));
});

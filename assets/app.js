/* Athena — surveillance des sites TOUFATECH (version autonome)
 * Données : Supabase (schéma athena), via la fonction protégée public.athena_rpc.
 * Les vérifications tournent côté base toutes les minutes (pg_cron), même page fermée. */
(() => {
  const $ = id => document.getElementById(id);
  const CFG = window.ATHENA_CONFIG || {};
  const sb = window.supabase && window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const TYPES = ["Site vitrine", "E-commerce", "Réservation / Rendez-vous", "Application / SaaS", "Blog / Média", "Portfolio", "Landing page", "Institutionnel", "Association", "Restaurant", "Immobilier", "Événementiel", "Formation / Éducation", "Forum / Communauté", "Intranet / Outil interne", "Autre"];
  const S = { sites: [], q: "", cat: "Tous", loaded: false, readOnly: false, menu: null, confirm: null, editing: null, revealed: false, view: "dash", me: null };
  const F = { logo: undefined };     // undefined = inchangé, "" = retiré, data URI = nouveau
  const live = {};
  const mon = { ov: null, busy: 0, retried: {}, down: false };
  const D = { id: null, tab: "apercu", period: "24h", fails: false, data: null, loading: false, err: null, ch: null, msg: {}, newKind: "discord" };

  const I = {
    dots: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
    arrow: '<svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 11 11 5M6 5h5v5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.2" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 3.5A1.5 1.5 0 0 0 9 2H4A2 2 0 0 0 2 4v5a1.5 1.5 0 0 0 1.5 1.5"/></svg>',
    cam: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.3l1-1.5h4.4l1 1.5h1.3A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" stroke-linejoin="round"/><circle cx="8" cy="8.5" r="2.3"/></svg>',
    edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.5 3 13 5.5 6 12.5H3.5V10Z" stroke-linejoin="round"/></svg>',
    del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3.5 5.5 8l4.5 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 3.5v9l7-4.5Z" stroke-linejoin="round"/></svg>',
    pause: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 3.5v9M10.5 3.5v9" stroke-linecap="round"/></svg>',
    bolt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 1.5 3.5 9h4l-1 5.5L12.5 7h-4Z" stroke-linejoin="round"/></svg>',
    ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3h4v4M13 3 7 9M11 9.5V13H3V5h3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const host = u => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
  const initials = n => { const w = String(n || "?").trim().split(/[\s\-_.]+/).filter(Boolean); return ((w[0]?.[0] || "?") + (w[1]?.[0] || "")).toUpperCase(); };
  const isImgData = v => typeof v === "string" && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(v);
  const fmtPct = v => v == null ? "—" : (Number(v) >= 99.995 ? "100" : Number(v).toFixed(2).replace(".", ",")) + " %";
  const fmtMs = v => v == null ? "—" : Math.round(v) + " ms";
  const dtf = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const dtfs = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dtd = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" });
  const fmtDate = iso => iso ? dtf.format(new Date(iso)) : "—";
  function normUrl(u) {
    u = (u || "").trim(); if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname.includes(".") ? x.href : ""; } catch { return ""; }
  }
  function ago(iso) {
    if (!iso) return "jamais";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return "à l'instant";
    if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`;
    if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
    return `il y a ${Math.round(s / 86400)} j`;
  }
  function dur(a, b) {
    const s = Math.max(0, ((b ? new Date(b) : new Date()) - new Date(a)) / 1000);
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
    return `${Math.floor(s / 86400)} j ${Math.round((s % 86400) / 3600)} h`;
  }
  let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("show"), 2400); }
  const toLocalInput = d => { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

  /* ---------- local preview cache (per browser) ---------- */
  const LS = "athena.live.v1";
  try { Object.assign(live, JSON.parse(localStorage.getItem(LS) || "{}")); for (const k in live) { live[k].checking = false; live[k].pending = false; } } catch {}
  function persist() {
    try { const o = {}; for (const k in live) { const { checking, pending, ...rest } = live[k]; o[k] = rest; } localStorage.setItem(LS, JSON.stringify(o)); }
    catch { try { const o = {}; for (const k in live) o[k] = { icon: live[k].icon }; localStorage.setItem(LS, JSON.stringify(o)); } catch {} }
  }

  /* ---------- API ---------- */
  class ApiError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
  async function rpc(action, args = {}) {
    const { data, error } = await sb.rpc("athena_rpc", { action, args });
    if (error) {
      if (error.code === "42501" && /Accès refusé/.test(error.message || "")) showDenied(error.message);
      if (error.code === "PGRST301" || error.code === "28000" || /JWT/i.test(error.message || "")) { await sb.auth.signOut(); }
      throw new ApiError(error.message || "La requête a échoué.", error.code);
    }
    if (mon.down) setNotice(null);
    return data;
  }
  const errText = e => (e && e.message ? e.message : "La requête a échoué.").slice(0, 200);
  function setNotice(html) {
    mon.down = !!html;
    $("notice").innerHTML = html || ""; $("notice").hidden = !html;
  }
  function netFail(e) {
    if (e && !e.code) setNotice(`<span><b>Connexion à la base impossible.</b> Les données affichées datent de la dernière lecture.</span><button class="btn sm" type="button" data-fix="retry">Réessayer</button>`);
  }
  $("notice").addEventListener("click", e => { if (e.target.closest("[data-fix]")) { setNotice(null); refreshAll(true); } });

  async function loadSites() {
    S.sites = await rpc("sites");
    S.loaded = true;
  }
  async function loadOverview() {
    const r = await rpc("overview");
    if (r) mon.ov = { ...r, byId: Object.fromEntries((r.monitors || []).map(m => [m.id, m])) };
  }
  async function loadPreview(url, force) {
    const L = live[url] || (live[url] = {});
    if (L.checking) return;
    L.checking = true; mon.busy++; renderDash();
    const known = L.previewAt && isImgData(L.preview) ? L.previewAt : null;
    try {
      const row = await rpc("check", { url, force: !!force, known });
      if (row) {
        if (isImgData(row.icon)) L.icon = row.icon;
        if (isImgData(row.preview)) { L.preview = row.preview; L.previewAt = row.preview_at; }
        L.pending = !!row.preview_pending;
        if (L.pending && !mon.retried[url]) { mon.retried[url] = true; setTimeout(() => { mon.retried[url] = false; loadPreview(url, force); }, 25000); }
      }
    } catch {}
    finally { L.checking = false; mon.busy--; persist(); renderDash(); if (S.view === "detail") renderDetail(); }
  }
  let refreshing = false;
  async function refreshAll(manual) {
    if (!S.me || refreshing) return;
    refreshing = true; mon.busy++; renderDash();
    try {
      await loadSites();
      await loadOverview();
      renderDash(); if (S.view === "detail") renderDetail();
      endSplash();
      S.sites.filter(s => { const L = live[s.url]; return manual || !L || !isImgData(L.preview) || !L.previewAt || Date.now() - new Date(L.previewAt) > 15 * 60000; })
        .forEach(s => loadPreview(s.url, false));
    } catch (e) { netFail(e); if (e.code) toast(errText(e)); S.loaded = true; endSplash(); }
    finally { refreshing = false; mon.busy--; renderDash(); }
  }
  $("refreshBtn").onclick = () => refreshAll(true);
  setInterval(() => { if (document.visibilityState === "visible" && S.me) { refreshAll(false); if (S.view === "detail" && !D.loading) loadDetail(true); } }, 60000);
  setInterval(() => { if (S.view === "dash" && S.me) renderStats(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.me) refreshAll(false); });

  /* ---------- status model ---------- */
  function statusOf(s) {
    const m = mon.ov && mon.ov.byId[s.id];
    if (m) {
      if (m.state === "paused") return { k: "idle", label: "En pause" };
      if (m.in_maintenance && m.state !== "down") return { k: "warn", label: "Maintenance" };
      if (m.state === "down") return { k: "down", label: "Hors ligne", ms: null, code: m.last_status };
      if (m.fail_count > 0) return { k: "warn", label: `Échec ${m.fail_count}/${m.retries}` };
      if (m.state === "degraded") return { k: "warn", label: "Lent", ms: m.last_ms };
      if (m.state === "up") return { k: "up", label: m.last_note === "Protégé par Cloudflare" ? "En ligne · Cloudflare" : "En ligne", ms: m.last_ms };
      return { k: "check", label: "1er contrôle en cours…" };
    }
    return mon.down ? { k: "idle", label: "Statut indisponible" } : { k: "check", label: "Vérification…" };
  }
  const cls = k => k === "up" ? "s-up" : k === "down" ? "s-down" : k === "warn" ? "s-warn" : k === "check" ? "s-check" : "s-idle";
  const pillHTML = st => `<span class="dot"></span>${esc(st.label)}${st.ms != null ? ` <span class="ms">${st.ms} ms</span>` : ""}${st.code ? ` <span class="ms">${st.code}</span>` : ""}`;
  function iconHTML(s) {
    const L = live[s.url] || {};
    const src = isImgData(s.logo) ? s.logo : (isImgData(L.icon) ? L.icon : null);
    return src ? `<img src="${esc(src)}" alt="">` : esc(initials(s.name));
  }

  /* ---------- dashboard ---------- */
  function renderStats() {
    const n = S.sites.length, ov = mon.ov;
    let up = 0, down = 0;
    for (const s of S.sites) { const k = statusOf(s).k; if (k === "up" || k === "warn") up++; else if (k === "down") down++; }
    const cell = (l, v, extra = "") => `<div class="stat"><span class="l">${l}</span><span class="v">${v}${extra}</span></div>`;
    $("stats").innerHTML =
      cell("Sites", n) +
      cell(`<span class="dot up"></span>En ligne`, ov ? up : "—") +
      cell(`<span class="dot down"></span>Hors ligne`, ov ? down : "—") +
      cell("Incidents ouverts", ov ? ov.open_incidents : "—") +
      cell("Disponibilité 24 h", ov && ov.up24 != null ? fmtPct(ov.up24).replace(" %", "") : "—", ov && ov.up24 != null ? "<small>%</small>" : "") +
      cell("Temps moyen", ov && ov.avg24 != null ? Math.round(ov.avg24) : "—", ov && ov.avg24 != null ? "<small>ms</small>" : "");
    $("refreshBtn").classList.toggle("spin", mon.busy > 0);
  }
  function beatsHTML(s) {
    const m = mon.ov && mon.ov.byId[s.id];
    const bars = (m && m.bars) || [];
    const cells = Array.from({ length: 40 }, (_, i) => { const b = bars[bars.length - 40 + i]; return b ? `<i class="${esc(b[0])}" title="${esc(fmtDate(b[1]))} · ${b[2] != null ? b[2] + " ms" : "échec"}"></i>` : "<i></i>"; }).join("");
    return `<div class="beats"><div class="beat" aria-hidden="true">${cells}</div><div class="pct">${m && m.up24 != null ? fmtPct(m.up24) : "—"}<small>24 h</small></div></div>`;
  }
  function renderDash() {
    if (!S.me) return;
    const present = [...new Set(S.sites.map(s => s.cat).filter(Boolean))].sort((a, b) => TYPES.indexOf(a) - TYPES.indexOf(b));
    if (S.cat !== "Tous" && !present.includes(S.cat)) S.cat = "Tous";
    $("chips").hidden = present.length < 1;
    $("chips").innerHTML = ["Tous", ...present].map(c => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === S.cat}">${esc(c)}</button>`).join("");
    $("addBtn").hidden = S.readOnly;
    $("empty").hidden = !S.loaded || S.sites.length > 0;
    renderStats();
    if (!S.loaded) {
      $("grid").innerHTML = Array.from({ length: 3 }, () => `<div class="card sk"><div class="shot"><div class="ph loading"></div></div><div class="meta"><div class="ico"></div><div class="idc"><div class="l1"></div><div class="l2"></div></div></div></div>`).join("");
      return;
    }
    const q = S.q.trim().toLowerCase();
    const list = S.sites
      .filter(s => S.cat === "Tous" || s.cat === S.cat)
      .filter(s => !q || [s.name, s.url, s.cat, s.note].some(v => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "fr"));
    $("grid").innerHTML = list.map((s, i) => {
      const st = statusOf(s), L = live[s.url] || {};
      const shot = isImgData(L.preview)
        ? `<img src="${L.preview}" alt="Aperçu de ${esc(s.name)}" loading="lazy">${L.previewAt ? `<span class="age">${esc(ago(L.previewAt))}</span>` : ""}`
        : `<div class="ph${(L.checking || L.pending || !L.previewAt) ? " loading" : ""}">${L.checking ? "" : esc(initials(s.name))}</div>`;
      return `
      <article class="card ${cls(st.k)}" data-id="${esc(s.id)}" style="--i:${i}">
        <a class="cover" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" aria-label="Ouvrir ${esc(s.name)}"></a>
        <div class="shot"><span class="pill">${pillHTML(st)}</span>${shot}</div>
        <div class="meta">
          <div class="ico">${iconHTML(s)}</div>
          <div class="idc">
            <div class="name"><span>${esc(s.name)}</span>${I.arrow}</div>
            <div class="sub">${esc(host(s.url))}${s.cat ? ` · <span class="type">${esc(s.cat)}</span>` : ""}</div>
          </div>
          <button type="button" class="more" data-act="menu" aria-label="Options pour ${esc(s.name)}" aria-expanded="${S.menu === s.id}">${I.dots}</button>
        </div>
        ${beatsHTML(s)}
        ${S.confirm === s.id ? `<div class="confirm">Supprimer ce site et son historique ?
          <button type="button" class="btn danger sm" data-act="del-yes">Supprimer</button>
          <button type="button" class="btn sm" data-act="del-no">Annuler</button></div>` : ""}
        ${S.menu === s.id ? `<div class="menu" role="menu">
          <button type="button" role="menuitem" class="strong" data-act="info">${I.info}Infos et surveillance</button>
          <button type="button" role="menuitem" data-act="copy">${I.copy}Copier le lien</button>
          ${S.readOnly ? "" : `<button type="button" role="menuitem" data-act="shot">${I.cam}Nouvelle capture</button>
          <button type="button" role="menuitem" data-act="edit">${I.edit}Modifier</button>
          <hr><button type="button" role="menuitem" class="del" data-act="del">${I.del}Supprimer</button>`}
        </div>` : ""}
      </article>`;
    }).join("");
  }

  /* ---------- detail ---------- */
  function openDetail(id, tab) {
    S.menu = null; S.confirm = null;
    D.id = id; D.tab = tab || "apercu"; D.data = null; D.err = null; D.msg = {};
    S.view = "detail";
    $("dash").hidden = true; $("detail").hidden = false;
    try { history.replaceState(null, "", "#" + encodeURIComponent(id)); } catch {}
    window.scrollTo({ top: 0 });
    renderDetail(); loadDetail(); loadChannels();
  }
  function closeDetail() {
    S.view = "dash"; D.id = null;
    $("detail").hidden = true; $("dash").hidden = false;
    try { history.replaceState(null, "", location.pathname); } catch {}
    renderDash();
  }
  $("home").onclick = () => { if (S.view === "detail") closeDetail(); };

  async function loadDetail(silent) {
    if (!D.id) return;
    D.loading = !silent; if (!silent) renderDetail();
    try {
      D.data = await rpc("detail", { id: D.id, period: D.period, fails: D.fails });
      D.err = D.data ? null : "Ce site n'est pas encore surveillé. Réessaie dans une minute.";
    } catch (e) { D.err = errText(e); netFail(e); }
    finally { D.loading = false; renderDetail(); }
  }
  async function loadChannels() {
    try { D.ch = await rpc("channels"); } catch {}
    if (S.view === "detail") renderDetail();
  }

  function chartSVG(series, period) {
    const W = 640, H = 170, L = 40, R = 10, T = 12, B = 22;
    const now = Date.now(), span = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6 }[period];
    const start = now - span;
    const pts = series.filter(p => p[1] != null).map(p => [new Date(p[0]).getTime(), Number(p[1])]);
    const max = Math.max(100, ...pts.map(p => p[1]));
    const nice = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000, 30000].find(v => v >= max) || max;
    const x = t => L + (W - L - R) * Math.min(1, Math.max(0, (t - start) / span));
    const y = v => T + (H - T - B) * (1 - v / nice);
    let g = "";
    [0, .5, 1].forEach(f => { const v = nice * f; g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v >= 1000 ? (v / 1000) + "s" : v}</text>`; });
    const lbl = t => period === "24h" ? new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(t) : dtd.format(t);
    [start, start + span / 2, now].forEach((t, i) => { g += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">${lbl(t)}</text>`; });
    if (!pts.length) return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pas encore de mesures">${g}<text x="${(L + W - R) / 2}" y="${H / 2}" text-anchor="middle" style="font-family:var(--font);font-size:12px">Pas encore de mesures sur cette période</text></svg>`;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
    const area = `${d} L${x(pts[pts.length - 1][0]).toFixed(1)},${y(0)} L${x(pts[0][0]).toFixed(1)},${y(0)} Z`;
    const last = pts[pts.length - 1];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temps de réponse sur la période">${g}<path class="area" d="${area}"/><path class="line" d="${d}"/><circle class="end" cx="${x(last[0])}" cy="${y(last[1])}" r="4"/></svg>`;
  }
  function stripHTML(series, period) {
    const n = { "24h": 48, "7d": 56, "30d": 60 }[period], span = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6 }[period];
    const start = Date.now() - span, step = span / n;
    const cells = Array.from({ length: n }, () => ({ ok: 0, tot: 0 }));
    series.forEach(p => { let i = Math.floor((new Date(p[0]).getTime() - start) / step); if (i >= n) i = n - 1; if (i >= 0) { cells[i].ok += p[2]; cells[i].tot += p[3]; } });
    return `<div class="strip" aria-hidden="true">${cells.map(c => `<i class="${!c.tot ? "" : c.ok === c.tot ? "up" : c.ok / c.tot >= .9 ? "mid" : "down"}"></i>`).join("")}</div>`;
  }
  const upClass = v => v == null ? "" : v >= 99.9 ? "good" : v >= 98 ? "mid" : "bad";
  const KIND = { http: "HTTP(S)", keyword: "HTTP + mot-clé", dns: "DNS" };
  const EVT = { down: "Panne détectée", up: "Retour en ligne", comment: "Commentaire", status: "Statut changé" };
  const ISTAT = { open: "Ouvert", investigating: "En analyse", identified: "Cause identifiée", resolved: "Résolu" };
  const CH = { discord: "Discord", slack: "Slack", telegram: "Telegram", webhook: "Webhook" };

  function renderDetail() {
    if (S.view !== "detail") return;
    const s = S.sites.find(x => x.id === D.id);
    if (!s) { if (S.loaded) closeDetail(); return; }
    const st = statusOf(s), data = D.data, m = data && data.monitor;
    const openInc = data ? data.incidents.filter(i => !i.ended_at).length : 0;
    const tabs = [["apercu", "Aperçu"], ["historique", "Historique"], ["incidents", "Incidents"], ["maintenance", "Maintenance"], ["alertes", "Alertes"], ["reglages", "Réglages"]]
      .filter(([k]) => !S.readOnly || !["maintenance", "reglages"].includes(k));
    let body = "";
    if (D.err && !data) body = `<div class="box"><p class="err">${esc(D.err)}</p><div><button class="btn sm" data-d="reload">Réessayer</button></div></div>`;
    else if (!data) body = `<div class="loading-box">Chargement de la surveillance…</div>`;
    else body = ({ apercu: tabApercu, historique: tabHisto, incidents: tabIncidents, maintenance: tabMaint, alertes: tabAlertes, reglages: tabReglages }[D.tab])(s, data);
    $("detail").innerHTML = `
      <button class="back" type="button" data-d="back">${I.back}Mes sites</button>
      <div class="dhead">
        <div class="ico">${iconHTML(s)}</div>
        <div class="t">
          <h1>${esc(s.name)}</h1>
          <div class="row"><span class="pill ${cls(st.k)}">${pillHTML(st)}</span><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(host(s.url))}</a></div>
          <div class="row">${s.cat ? `<span class="tag">${esc(s.cat)}</span>` : ""}${m ? `<span class="tag">${esc(KIND[m.kind] || m.kind)}${m.kind !== "dns" ? " " + esc(m.method) : ""}</span>${(m.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join("")}` : ""}</div>
        </div>
        <div class="dacts">
          ${S.readOnly ? "" : `<button class="btn sm" type="button" data-d="run" ${!m ? "disabled" : ""}>${I.bolt}Vérifier maintenant</button>
          ${m ? `<button class="btn sm" type="button" data-d="pause">${m.paused ? I.play + "Reprendre" : I.pause + "Pause"}</button>` : ""}`}
          <a class="btn sm" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${I.ext}Ouvrir</a>
        </div>
      </div>
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${D.tab === k}">${l}${k === "incidents" && openInc ? `<span class="cnt">${openInc}</span>` : ""}</button>`).join("")}</div>
      <div class="panel fadein">${body}</div>`;
  }
  const periodSeg = () => `<div class="seg" role="group" aria-label="Période">${[["24h", "24 h"], ["7d", "7 j"], ["30d", "30 j"]].map(([k, l]) => `<button type="button" data-period="${k}" aria-pressed="${D.period === k}">${l}</button>`).join("")}</div>`;

  function tabApercu(s, d) {
    const m = d.monitor, u = d.uptime, x = d.stats || {};
    const L = live[s.url] || {};
    return `
      <div class="kpis">
        <div class="kpi"><div class="l">Disponibilité 24 h</div><div class="v ${upClass(u.d1)}">${fmtPct(u.d1)}</div><div class="s">7 j : ${fmtPct(u.d7)}</div></div>
        <div class="kpi"><div class="l">Disponibilité 30 j</div><div class="v ${upClass(u.d30)}">${fmtPct(u.d30)}</div><div class="s">90 j : ${fmtPct(u.d90)}</div></div>
        <div class="kpi"><div class="l">Temps de réponse</div><div class="v">${fmtMs(x.avg)}</div><div class="s">p95 ${fmtMs(x.p95)} · max ${fmtMs(x.max)}</div></div>
        <div class="kpi"><div class="l">Dernier contrôle</div><div class="v" style="font-size:17px;padding-top:4px">${esc(ago(m.last_check_at))}</div><div class="s">${m.last_status ? "Code " + m.last_status + " · " : ""}${fmtMs(m.last_ms)}</div></div>
      </div>
      ${m.last_error ? `<div class="box" style="border-color:color-mix(in srgb,var(--down) 40%,var(--line))"><h3>Raison du dernier échec</h3><p class="hint" style="color:var(--ink)">${esc(m.last_error)}</p></div>` : ""}
      ${d.in_maintenance ? `<div class="box"><h3>Maintenance en cours</h3><p class="hint">Les contrôles continuent mais ne comptent pas dans la disponibilité.</p></div>` : ""}
      <div class="box">
        <h3>Temps de réponse ${periodSeg()}</h3>
        ${chartSVG(d.series, D.period)}
        ${stripHTML(d.series, D.period)}
        <div class="strip-l"><span>${x.count || 0} contrôles</span><span>${x.fails || 0} échec${x.fails > 1 ? "s" : ""}</span></div>
      </div>
      <div class="split">
        <div class="box">
          <h3>Aperçu ${L.previewAt ? `<span class="hint">${esc(ago(L.previewAt))}</span>` : ""}</h3>
          <div class="shot-d">${isImgData(L.preview) ? `<img src="${L.preview}" alt="Capture de ${esc(s.name)}">` : `<div class="ph loading" style="position:static;height:100%"></div>`}</div>
          ${S.readOnly ? "" : `<div><button class="btn sm" type="button" data-d="shot">${I.cam}Nouvelle capture</button></div>`}
        </div>
        <div class="box">
          <h3>Configuration</h3>
          <dl class="kv">
            <dt>Type</dt><dd>${esc(KIND[m.kind])}${m.kind !== "dns" ? " · " + esc(m.method) : ""}</dd>
            <dt>Fréquence</dt><dd>toutes les ${m.interval_s / 60} min</dd>
            <dt>Délai max</dt><dd>${m.timeout_ms / 1000} s</dd>
            <dt>Alerte après</dt><dd>${m.retries} échec${m.retries > 1 ? "s" : ""} consécutif${m.retries > 1 ? "s" : ""}</dd>
            <dt>Codes attendus</dt><dd>${esc(m.expected_codes)}</dd>
            ${m.kind === "keyword" ? `<dt>Mot-clé</dt><dd>${m.keyword_invert ? "absent : " : ""}« ${esc(m.keyword || "")} »</dd>` : ""}
            <dt>Seuil « lent »</dt><dd>${fmtMs(m.degraded_ms)}</dd>
            <dt>Rappel d'alerte</dt><dd>${m.repeat_min ? "toutes les " + m.repeat_min + " min" : "désactivé"}</dd>
            <dt>Dernier succès</dt><dd>${esc(fmtDate(m.last_ok_at))}</dd>
            <dt>Contrôlé depuis</dt><dd>Supabase · Irlande</dd>
          </dl>
          ${S.readOnly ? "" : `<button class="btn sm" type="button" data-tab="reglages" style="align-self:flex-start">${I.edit}Modifier</button>`}
        </div>
      </div>
      <div class="box">
        <h3>Métriques serveur <span class="badge">Non configuré</span></h3>
        <p class="hint">CPU, mémoire, disque et réseau nécessitent un agent installé sur le serveur. ${/vercel/i.test(s.note || "") ? "Ce site est hébergé sur Vercel (sans serveur dédié) : il n'y a pas de machine à surveiller." : "Aucun agent n'est installé pour ce site."}</p>
      </div>
      <p class="hint">Disponibilité = contrôles réussis ÷ contrôles effectués sur la période, hors fenêtres de maintenance. Les périodes sans mesure ne comptent pas.</p>`;
  }

  function tabHisto(s, d) {
    const rows = d.checks.map(c => {
      const k = c.ok ? (c.state === "degraded" ? "mid" : "ok") : (c.state === "pending" ? "mid" : "ko");
      const lab = c.ok ? (c.state === "degraded" ? "Lent" : "OK") : (c.state === "pending" ? "Échec (nouvel essai)" : "Échec");
      return `<tr><td class="m">${esc(dtf.format(new Date(c.at)))}<br><span style="color:var(--muted)">${esc(dtfs.format(new Date(c.at)))}</span></td><td><span class="st ${k}"><span class="dot ${k === "ok" ? "up" : k === "mid" ? "warn" : "down"}"></span>${lab}</span>${c.maintenance ? ` <span class="badge mid">maint.</span>` : ""}</td><td class="m">${c.status ?? "—"}</td><td class="m">${c.ms != null ? c.ms + " ms" : "—"}</td><td class="err">${esc(c.error || c.note || "")}</td><td class="m" style="color:var(--muted)">${esc(c.worker)}</td></tr>`;
    }).join("");
    return `
      <div class="box">
        <h3>Journal des vérifications ${periodSeg()}</h3>
        <label class="toggle"><input type="checkbox" id="d-fails" ${D.fails ? "checked" : ""}> Échecs uniquement</label>
        ${d.checks.length ? `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Résultat</th><th>Code</th><th>Temps</th><th>Détail</th><th>Emplacement</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint">${d.checks.length >= 200 ? "Les 200 contrôles les plus récents de la période." : d.checks.length + " contrôle" + (d.checks.length > 1 ? "s" : "") + " sur la période."}</p>` : `<p class="hint">Aucun contrôle ${D.fails ? "en échec " : ""}sur cette période.</p>`}
      </div>`;
  }

  function tabIncidents(s, d) {
    if (!d.incidents.length) return `<div class="empty"><b>Aucun incident</b>Un incident s'ouvre automatiquement après ${d.monitor.retries} échecs consécutifs, et se ferme au retour en ligne.</div>`;
    return d.incidents.map(i => {
      const open = !i.ended_at;
      const bcls = i.status === "resolved" ? "res" : open && i.status === "open" ? "open" : "mid";
      return `<div class="inc ${open ? "open" : ""}">
        <div class="top"><b>${esc(fmtDate(i.started_at))}</b><span class="badge ${bcls}">${esc(ISTAT[i.status] || i.status)}</span></div>
        <div class="hint">Durée : ${esc(dur(i.started_at, i.ended_at))}${open ? " (en cours)" : ""}${i.cause ? " · " + esc(i.cause) : ""}</div>
        ${i.root_cause ? `<div style="font-size:13px"><b>Cause racine :</b> ${esc(i.root_cause)}</div>` : ""}
        <ul class="tl">${i.events.map(e => `<li class="${esc(e.kind)}"><time>${esc(dtf.format(new Date(e.at)))}</time><b>${esc(EVT[e.kind] || e.kind)}</b>${e.body ? " · " + esc(e.kind === "status" ? (ISTAT[e.body] || e.body) : e.body) : ""}</li>`).join("")}</ul>
        ${S.readOnly ? "" : `<details>
          <summary class="hint" style="cursor:pointer">Ajouter un commentaire ou changer le statut</summary>
          <div class="form" style="margin-top:10px">
            <label class="field full">Commentaire<textarea id="ic-${i.id}" maxlength="2000"></textarea></label>
            <label class="field">Statut<select id="is-${i.id}">${Object.entries(ISTAT).map(([k, l]) => `<option value="${k}" ${k === i.status ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label class="field">Cause racine<input id="ir-${i.id}" maxlength="2000" value="${esc(i.root_cause || "")}" placeholder="Facultatif"></label>
            <div class="row-end full"><span class="err" id="ie-${i.id}"></span><button class="btn solid sm" type="button" data-d="inc-save" data-id="${i.id}">Enregistrer</button></div>
          </div>
        </details>`}
      </div>`;
    }).join("");
  }

  function tabMaint(s, d) {
    const now = new Date(), later = new Date(now.getTime() + 3600e3);
    const items = d.maintenance.map(x => {
      const active = new Date(x.starts_at) <= now && now <= new Date(x.ends_at), past = new Date(x.ends_at) < now;
      return `<div class="li"><div class="grow"><b>${esc(x.title)}</b> ${active ? `<span class="badge mid">En cours</span>` : past ? `<span class="badge">Terminée</span>` : `<span class="badge">Programmée</span>`}<div>${esc(fmtDate(x.starts_at))} → ${esc(fmtDate(x.ends_at))} · ${x.all ? "tous les sites" : "ce site"} · ${x.mute ? "alertes coupées" : "alertes actives"}</div></div>${past ? "" : `<button class="btn sm danger" type="button" data-d="maint-del" data-id="${x.id}">Supprimer</button>`}</div>`;
    }).join("");
    return `
      <div class="box">
        <h3>Programmer une maintenance</h3>
        <p class="hint">Pendant une maintenance, les contrôles ne comptent pas dans la disponibilité et les alertes peuvent être coupées.</p>
        <div class="form">
          <label class="field full">Titre<input id="m-title" maxlength="120" placeholder="Mise à jour du site"></label>
          <label class="field">Début<input id="m-start" type="datetime-local" value="${toLocalInput(now)}"></label>
          <label class="field">Fin<input id="m-end" type="datetime-local" value="${toLocalInput(later)}"></label>
          <label class="toggle"><input type="checkbox" id="m-mute" checked> Couper les alertes</label>
          <label class="toggle"><input type="checkbox" id="m-all"> Tous les sites</label>
          <div class="row-end full"><span class="err" id="m-err"></span><button class="btn solid sm" type="button" data-d="maint-add">Programmer</button></div>
        </div>
      </div>
      <div class="box"><h3>Maintenances</h3>${items ? `<div class="list">${items}</div>` : `<p class="hint">Aucune maintenance sur les 30 derniers jours.</p>`}</div>`;
  }

  function tabAlertes(s, d) {
    const chans = D.ch ? D.ch.channels : null;
    const forThis = c => !c.monitor_ids || c.monitor_ids.includes(s.id);
    const list = chans == null ? `<p class="hint">Chargement des canaux…</p>` : chans.length ? `<div class="list">${chans.map(c => `
      <div class="li"><div class="grow"><b>${esc(c.name)}</b> <span class="tag">${esc(CH[c.kind])}</span> ${c.enabled ? "" : `<span class="badge">Désactivé</span>`}
        <div>${esc(c.target)} · ${c.monitor_ids ? (forThis(c) ? "ce site" : "autres sites") : "tous les sites"} · ${[c.on_down && "pannes", c.on_up && "retours"].filter(Boolean).join(" et ") || "aucun événement"}</div></div>
        ${S.readOnly ? "" : `<button class="btn sm" type="button" data-d="ch-test" data-id="${c.id}">Tester</button>
        <button class="btn sm" type="button" data-d="ch-toggle" data-id="${c.id}">${c.enabled ? "Désactiver" : "Activer"}</button>
        <button class="btn sm danger" type="button" data-d="ch-del" data-id="${c.id}">Supprimer</button>`}
      </div>`).join("")}</div>` : `<p class="hint">Aucun canal. Ajoute-en un pour être prévenu quand un site tombe.</p>`;
    const kind = D.newKind;
    const deliv = d.deliveries.length ? `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Événement</th><th>Canal</th><th>Résultat</th></tr></thead><tbody>${d.deliveries.map(x => `<tr><td class="m">${esc(fmtDate(x.at))}</td><td>${esc({ down: "Panne", up: "Retour", still_down: "Rappel" }[x.event] || x.event)}</td><td>${esc(x.channel || "—")}</td><td>${x.ok ? `<span class="st ok">Envoyé</span>` : `<span class="st ko">Échec</span> <span class="hint">${esc(x.error || "")}</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">Aucune alerte envoyée pour ce site.</p>`;
    return `
      <div class="box"><h3>Canaux d'alerte</h3>${list}${D.msg.ch ? `<p class="${D.msg.chOk ? "ok-msg" : "err"}">${esc(D.msg.ch)}</p>` : ""}</div>
      ${S.readOnly ? "" : `<div class="box">
        <h3>Ajouter un canal</h3>
        <div class="form">
          <label class="field">Type<select id="c-kind">${Object.entries(CH).map(([k, l]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="field">Nom<input id="c-name" maxlength="60" placeholder="${esc(CH[kind])} équipe"></label>
          ${kind === "telegram" ? `
          <label class="field">Jeton du bot<input id="c-token" class="mono" autocomplete="off" placeholder="123456:ABC…"><small>Donné par @BotFather</small></label>
          <label class="field">ID du chat<input id="c-chat" class="mono" autocomplete="off" placeholder="-100123… ou @canal"></label>` : `
          <label class="field full">Adresse du webhook<input id="c-url" class="mono" autocomplete="off" placeholder="https://…"><small>${kind === "discord" ? "Salon Discord → Paramètres → Intégrations → Webhooks" : kind === "slack" ? "Slack → Apps → Incoming Webhooks" : "Reçoit un JSON : event, monitor, incident_id, detail, at"}</small></label>`}
          <label class="field">Sites concernés<select id="c-scope"><option value="all">Tous les sites</option><option value="one">Seulement ${esc(s.name)}</option></select></label>
          <div class="field">Événements<label class="toggle"><input type="checkbox" id="c-down" checked> Pannes</label><label class="toggle"><input type="checkbox" id="c-up" checked> Retours en ligne</label></div>
          <div class="row-end full"><span class="err" id="c-err"></span><button class="btn solid sm" type="button" data-d="ch-add">Ajouter le canal</button></div>
        </div>
        <p class="hint">Les secrets (jetons, adresses) restent dans la base et ne sont jamais réaffichés en entier. L'e-mail n'est pas disponible : utilise Discord, Slack, Telegram ou un webhook.</p>
      </div>`}
      <div class="box"><h3>Alertes envoyées pour ce site</h3>${deliv}</div>`;
  }

  function tabReglages(s, d) {
    const m = d.monitor;
    const opt = (v, cur, l) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${l}</option>`;
    return `
      <div class="box">
        <h3>Surveillance</h3>
        <div class="form">
          <label class="field">Type de contrôle<select id="r-kind">${opt("http", m.kind, "HTTP(S) – code de réponse")}${opt("keyword", m.kind, "HTTP(S) + mot-clé")}${opt("dns", m.kind, "DNS – résolution du domaine")}</select></label>
          <label class="field">Méthode<select id="r-method">${opt("GET", m.method, "GET")}${opt("HEAD", m.method, "HEAD")}${opt("POST", m.method, "POST")}</select></label>
          <label class="field">Fréquence<select id="r-interval">${[60, 120, 300, 600, 900, 1800, 3600].map(v => opt(v, m.interval_s, v < 3600 ? `Toutes les ${v / 60} min` : "Toutes les heures")).join("")}</select></label>
          <label class="field">Délai max (s)<input id="r-timeout" type="number" min="1" max="30" step="1" value="${m.timeout_ms / 1000}"></label>
          <label class="field">Échecs avant alerte<input id="r-retries" type="number" min="1" max="10" step="1" value="${m.retries}"></label>
          <label class="field">Codes HTTP attendus<input id="r-codes" class="mono" value="${esc(m.expected_codes)}" placeholder="200-399"><small>Ex. 200-299,301</small></label>
          <label class="field">Mot-clé<input id="r-keyword" maxlength="200" value="${esc(m.keyword || "")}" placeholder="Utilisé avec le type « mot-clé »"></label>
          <label class="toggle" style="align-self:end;padding-bottom:10px"><input type="checkbox" id="r-invert" ${m.keyword_invert ? "checked" : ""}> Alerter si le mot-clé est présent</label>
          <label class="field">Seuil « lent » (ms)<input id="r-degraded" type="number" min="100" max="60000" step="100" value="${m.degraded_ms}"></label>
          <label class="field">Rappel tant que c'est en panne<select id="r-repeat">${[0, 15, 30, 60, 180, 720].map(v => opt(v, m.repeat_min, v ? (v < 60 ? `Toutes les ${v} min` : `Toutes les ${v / 60} h`) : "Jamais")).join("")}</select></label>
          <label class="field full">Étiquettes<input id="r-tags" maxlength="300" value="${esc((m.tags || []).join(", "))}" placeholder="client, prod, mayotte"><small>Séparées par des virgules</small></label>
          <label class="toggle full"><input type="checkbox" id="r-paused" ${m.paused ? "checked" : ""}> Mettre la surveillance en pause</label>
          <div class="row-end full"><span class="${D.msg.r && D.msg.rOk ? "ok-msg" : "err"}" id="r-err">${esc(D.msg.r || "")}</span><button class="btn solid sm" type="button" data-d="r-save">Enregistrer</button></div>
        </div>
      </div>
      <div class="box">
        <h3>Ce que vérifie Athena</h3>
        <p class="hint">Chaque contrôle part de Supabase (Irlande). Le certificat HTTPS est validé à chaque fois : un certificat expiré ou invalide compte comme un échec. Les redirections sont suivies en GET. Un incident s'ouvre après le nombre d'échecs choisi, une seule alerte est envoyée, puis une alerte de retour à la résolution.</p>
      </div>`;
  }

  $("detail").addEventListener("change", e => {
    if (e.target.id === "d-fails") { D.fails = e.target.checked; loadDetail(); }
    else if (e.target.id === "c-kind") { D.newKind = e.target.value; renderDetail(); }
  });
  $("detail").addEventListener("click", async e => {
    const t = e.target.closest("[data-tab],[data-period],[data-d]"); if (!t) return;
    if (t.dataset.tab) { D.tab = t.dataset.tab; D.msg = {}; renderDetail(); return; }
    if (t.dataset.period) { D.period = t.dataset.period; loadDetail(); return; }
    const a = t.dataset.d, s = S.sites.find(x => x.id === D.id);
    if (a === "back") return closeDetail();
    if (a === "reload") return loadDetail();
    if (a === "shot") { toast("Nouvelle capture demandée"); return loadPreview(s.url, true); }
    const busy = async fn => { t.disabled = true; try { await fn(); } finally { if (t.isConnected) t.disabled = false; } };
    const after = async () => { await loadDetail(true); loadOverview().then(renderDash).catch(() => {}); };
    if (a === "run") return busy(async () => {
      try { const r = await rpc("run", { id: D.id }); toast(r.ok ? `En ligne · ${r.ms} ms` : `Échec : ${r.error || "inconnu"}`); }
      catch (x) { toast("Vérification impossible : " + errText(x)); }
      await loadOverview().catch(() => {}); await loadDetail(true); renderDash();
    });
    if (a === "pause") return busy(async () => {
      const p = !D.data.monitor.paused;
      try { await rpc("save_monitor", { id: D.id, cfg: { paused: p } }); toast(p ? "Surveillance en pause" : "Surveillance reprise"); }
      catch (x) { toast(errText(x)); }
      await after();
    });
    if (a === "r-save") return busy(async () => {
      const v = id => $(id).value;
      const cfg = {
        kind: v("r-kind"), method: v("r-method"), interval_s: +v("r-interval"),
        timeout_ms: Math.round(Math.min(30, Math.max(1, +v("r-timeout") || 10)) * 1000),
        retries: Math.min(10, Math.max(1, Math.round(+v("r-retries") || 3))),
        expected_codes: v("r-codes").trim() || "200-399", keyword: v("r-keyword").trim(), keyword_invert: $("r-invert").checked,
        degraded_ms: Math.min(60000, Math.max(100, Math.round(+v("r-degraded") || 3000))), repeat_min: +v("r-repeat"),
        tags: v("r-tags").split(",").map(x => x.trim()).filter(Boolean), paused: $("r-paused").checked
      };
      if (cfg.kind === "keyword" && !cfg.keyword) { D.msg = { r: "Indique le mot-clé à chercher." }; return renderDetail(); }
      try { await rpc("save_monitor", { id: D.id, cfg }); D.msg = { r: "Réglages enregistrés.", rOk: true }; }
      catch (x) { D.msg = { r: errText(x) }; }
      await after();
    });
    if (a === "inc-save") return busy(async () => {
      const id = +t.dataset.id, inc = D.data.incidents.find(i => i.id === id);
      const c = $("ic-" + id).value.trim(), stv = $("is-" + id).value, root = $("ir-" + id).value.trim();
      try {
        await rpc("incident_update", { iid: id, comment: c || null, status: stv !== inc.status ? stv : null, root: root !== (inc.root_cause || "") ? root : null });
        toast("Incident mis à jour");
      } catch (x) { $("ie-" + id).textContent = errText(x); return; }
      await after();
    });
    if (a === "maint-add") return busy(async () => {
      const st = new Date($("m-start").value), en = new Date($("m-end").value);
      if (isNaN(st) || isNaN(en)) { $("m-err").textContent = "Indique un début et une fin."; return; }
      if (en <= st) { $("m-err").textContent = "La fin doit être après le début."; return; }
      try {
        await rpc("maintenance_add", { id: $("m-all").checked ? null : D.id, title: $("m-title").value.trim() || "Maintenance", starts: st.toISOString(), ends: en.toISOString(), mute: $("m-mute").checked });
        toast("Maintenance programmée");
      } catch (x) { $("m-err").textContent = errText(x); return; }
      await after();
    });
    if (a === "maint-del") return busy(async () => {
      try { await rpc("maintenance_delete", { xid: +t.dataset.id }); toast("Maintenance supprimée"); } catch (x) { toast(errText(x)); }
      await loadDetail(true);
    });
    if (a === "ch-add") return busy(async () => {
      const kind = $("c-kind").value;
      const cfg = kind === "telegram" ? { token: $("c-token").value.trim(), chat_id: $("c-chat").value.trim() } : { url: $("c-url").value.trim() };
      try {
        await rpc("channel_save", { cid: null, kind, name: $("c-name").value.trim() || CH[kind], cfg, monitor_ids: $("c-scope").value === "one" ? [D.id] : null, enabled: true, on_down: $("c-down").checked, on_up: $("c-up").checked });
        D.msg = { ch: "Canal ajouté. Appuie sur « Tester » pour vérifier qu'il reçoit bien les messages.", chOk: true };
      } catch (x) { $("c-err").textContent = errText(x); return; }
      await loadChannels();
    });
    if (a === "ch-test") return busy(async () => {
      try { const r = await rpc("channel_test", { cid: +t.dataset.id }); D.msg = r.ok ? { ch: "Message de test envoyé.", chOk: true } : { ch: "Échec de l'envoi : " + (r.error || "code " + r.status) }; }
      catch (x) { D.msg = { ch: errText(x) }; }
      await loadChannels();
    });
    if (a === "ch-toggle") return busy(async () => {
      const c = D.ch.channels.find(x => x.id === +t.dataset.id);
      try { await rpc("channel_save", { cid: c.id, kind: c.kind, name: c.name, cfg: {}, monitor_ids: c.monitor_ids, enabled: !c.enabled, on_down: c.on_down, on_up: c.on_up }); }
      catch (x) { D.msg = { ch: errText(x) }; }
      await loadChannels();
    });
    if (a === "ch-del") {
      if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Confirmer"; setTimeout(() => { if (t.isConnected) { t.dataset.sure = ""; t.textContent = "Supprimer"; } }, 4000); return; }
      return busy(async () => {
        try { await rpc("channel_delete", { cid: +t.dataset.id }); D.msg = { ch: "Canal supprimé.", chOk: true }; } catch (x) { D.msg = { ch: errText(x) }; }
        await loadChannels();
      });
    }
  });

  /* ---------- add / edit sheet ---------- */
  function fillTypes(cur) {
    const opts = TYPES.slice(); if (cur && !opts.includes(cur)) opts.unshift(cur);
    $("f-cat").innerHTML = `<option value="">Choisir un type…</option>` + opts.map(t => `<option ${t === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  }
  function setPreview() {
    const site = S.sites.find(s => s.id === S.editing);
    const src = F.logo !== undefined ? (F.logo || null) : (site && isImgData(site.logo) ? site.logo : null);
    const fav = site && isImgData(live[site.url]?.icon) ? live[site.url].icon : null;
    $("logoPrev").innerHTML = src ? `<img src="${esc(src)}" alt="">` : fav ? `<img src="${esc(fav)}" alt="">` : esc(initials($("f-name").value || "?"));
    $("dropLogo").hidden = !src;
  }
  function openSheet(site) {
    S.editing = site ? site.id : null; S.menu = null; F.logo = undefined;
    $("formTitle").textContent = site ? "Modifier le site" : "Nouveau site";
    $("f-name").value = site?.name || ""; $("f-url").value = site?.url || "";
    fillTypes(site?.cat || ""); $("f-note").value = site?.note || "";
    $("formErr").hidden = true; $("scrim").hidden = false; setPreview(); renderDash();
    setTimeout(() => $("f-name").focus(), 50);
  }
  function closeSheet() { $("scrim").hidden = true; S.editing = null; F.logo = undefined; }
  const ferr = m => { $("formErr").textContent = m; $("formErr").hidden = false; };
  $("addBtn").onclick = () => openSheet(null);
  $("cancelBtn").onclick = closeSheet;
  $("scrim").addEventListener("click", e => { if (e.target === $("scrim")) closeSheet(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { if (!$("scrim").hidden) closeSheet(); else if (S.menu || S.confirm) { S.menu = S.confirm = null; renderDash(); } else if (S.view === "detail") closeDetail(); }
  });
  $("f-name").addEventListener("input", setPreview);
  $("pickLogo").onclick = () => $("f-logo").click();
  $("f-logo").onchange = e => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return ferr("Cette image dépasse 8 Mo.");
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => {
      const size = 160, c = document.createElement("canvas"); c.width = c.height = size;
      const ctx = c.getContext("2d"), r = Math.min(size / img.width, size / img.height);
      const w = img.width * r, h = img.height * r;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      F.logo = c.toDataURL("image/png"); $("formErr").hidden = true; setPreview();
    };
    img.onerror = () => { URL.revokeObjectURL(url); ferr("Image illisible. Utilise un PNG, JPG ou WebP."); };
    img.src = url;
  };
  $("dropLogo").onclick = () => { F.logo = ""; setPreview(); };
  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("f-name").value.trim(), url = normUrl($("f-url").value);
    if (!name) return ferr("Donne un nom au site.");
    if (!url) return ferr("Cette adresse n'est pas valide. Exemple : monsite.com");
    const prev = S.sites.find(s => s.id === S.editing);
    const args = { id: prev ? prev.id : null, name, url, cat: $("f-cat").value, note: $("f-note").value.trim() };
    if (F.logo !== undefined) args.logo = F.logo || null;
    $("saveBtn").disabled = true; $("saveBtn").textContent = "Enregistrement…";
    try {
      await rpc("site_save", args);
      toast(prev ? "Site modifié" : "Site ajouté · premier contrôle dans une minute");
      closeSheet();
      await refreshAll(false);
      if (!prev || prev.url !== url) loadPreview(url, false);
    } catch (x) { ferr(errText(x)); }
    finally { $("saveBtn").disabled = false; $("saveBtn").textContent = "Enregistrer"; }
  });

  /* ---------- card interactions ---------- */
  $("q").addEventListener("input", e => { S.q = e.target.value; renderDash(); });
  $("chips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) { S.cat = b.dataset.cat; renderDash(); } });
  document.addEventListener("click", e => { if (S.menu && !e.target.closest(".menu") && !e.target.closest(".more")) { S.menu = null; renderDash(); } });
  $("grid").addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    e.preventDefault();
    const id = b.closest(".card").dataset.id, s = S.sites.find(x => x.id === id); if (!s) return;
    const a = b.dataset.act;
    if (a === "menu") { S.menu = S.menu === id ? null : id; S.confirm = null; renderDash(); }
    else if (a === "info") openDetail(id);
    else if (a === "copy") {
      S.menu = null; renderDash();
      try { await navigator.clipboard.writeText(s.url); toast("Lien copié"); } catch { toast(s.url); }
    }
    else if (a === "shot") { S.menu = null; toast("Nouvelle capture demandée"); loadPreview(s.url, true); }
    else if (a === "edit") openSheet(s);
    else if (a === "del") { S.menu = null; S.confirm = id; renderDash(); }
    else if (a === "del-no") { S.confirm = null; renderDash(); }
    else if (a === "del-yes") {
      try { await rpc("site_delete", { id }); toast("Site supprimé"); await refreshAll(false); }
      catch (x) { toast("La suppression a échoué : " + errText(x)); }
      S.confirm = null; renderDash();
    }
  });

  /* ---------- splash ---------- */
  const started = performance.now();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let splashDone = false;
  function endSplash() {
    if (splashDone) return; splashDone = true;
    const wait = reduce ? 0 : Math.max(0, 1800 - (performance.now() - started));
    setTimeout(() => {
      $("splash").classList.add("out");
      if (S.loaded && !S.revealed && S.view === "dash") { S.revealed = true; $("grid").classList.add("reveal"); setTimeout(() => $("grid").classList.remove("reveal"), 1400); }
    }, wait);
  }
  setTimeout(endSplash, 5000);

  /* ---------- auth ---------- */
  let authMode = "login";
  function showView(v) {
    $("auth").hidden = v !== "auth"; $("denied").hidden = v !== "denied";
    $("headR").hidden = v !== "app";
    $("dash").hidden = v !== "app" || S.view === "detail";
    $("detail").hidden = v !== "app" || S.view !== "detail";
    if (v !== "app") setNotice(null);
  }
  function setAuthMode(mode) {
    authMode = mode;
    const t = { login: ["Connexion", "Accès réservé aux comptes autorisés.", "Se connecter"],
                signup: ["Créer mon compte", "Utilise une adresse autorisée. Tu recevras un e-mail de confirmation.", "Créer le compte"],
                reset: ["Mot de passe oublié", "Tu recevras un lien pour choisir un nouveau mot de passe.", "Envoyer le lien"],
                newpw: ["Nouveau mot de passe", "Choisis ton nouveau mot de passe (8 caractères minimum).", "Enregistrer"] }[mode];
    $("authTitle").textContent = t[0]; $("authHint").textContent = t[1]; $("authSubmit").textContent = t[2];
    $("emailField").hidden = mode === "newpw"; $("pwField").hidden = mode === "reset";
    $("a-pw").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("toSignup").textContent = mode === "login" ? "Créer mon compte" : "J'ai déjà un compte";
    $("toReset").hidden = mode !== "login";
    $("authErr").hidden = true; $("authOk").hidden = true;
  }
  $("toSignup").onclick = () => setAuthMode(authMode === "login" ? "signup" : "login");
  $("toReset").onclick = () => setAuthMode("reset");
  const aErr = m => { $("authErr").textContent = m; $("authErr").hidden = false; $("authOk").hidden = true; };
  const aOk = m => { $("authOk").textContent = m; $("authOk").hidden = false; $("authErr").hidden = true; };
  const frAuth = m => {
    if (/Invalid login credentials/i.test(m)) return "E-mail ou mot de passe incorrect.";
    if (/Email not confirmed/i.test(m)) return "Confirme d'abord ton adresse avec le lien reçu par e-mail.";
    if (/User already registered/i.test(m)) return "Un compte existe déjà avec cette adresse. Connecte-toi.";
    if (/Password should be/i.test(m)) return "Le mot de passe doit faire au moins 8 caractères.";
    if (/rate limit|security purposes/i.test(m)) return "Trop de tentatives. Réessaie dans quelques minutes.";
    return m;
  };
  $("authForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("a-email").value.trim(), pw = $("a-pw").value;
    if (authMode !== "newpw" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return aErr("Indique une adresse e-mail valide.");
    if ((authMode === "signup" || authMode === "newpw") && pw.length < 8) return aErr("Le mot de passe doit faire au moins 8 caractères.");
    if (authMode === "login" && !pw) return aErr("Indique ton mot de passe.");
    const btn = $("authSubmit"); btn.disabled = true;
    try {
      if (authMode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
      } else if (authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (!data.session) aOk("Compte créé. Ouvre le lien reçu par e-mail pour le confirmer, puis reviens te connecter ici.");
      } else if (authMode === "reset") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
        if (error) throw error;
        aOk("Si ce compte existe, un lien vient d'être envoyé.");
      } else if (authMode === "newpw") {
        const { error } = await sb.auth.updateUser({ password: pw });
        if (error) throw error;
        toast("Mot de passe modifié");
        boot();
      }
    } catch (x) { aErr(frAuth(x.message || "La connexion a échoué.")); }
    finally { btn.disabled = false; }
  });
  async function logout() { await sb.auth.signOut(); S.me = null; S.sites = []; mon.ov = null; S.loaded = false; S.view = "dash"; setAuthMode("login"); showView("auth"); }
  $("logoutBtn").onclick = logout;
  $("deniedLogout").onclick = logout;
  function showDenied(msg) { $("deniedText").textContent = (msg || "Ce compte n'est pas autorisé sur Athena.") + " Demande à un administrateur d'ajouter ton adresse."; S.me = null; showView("denied"); endSplash(); }

  let booting = false;
  async function boot() {
    if (booting) return; booting = true;
    try { await bootInner(); } finally { booting = false; }
  }
  async function bootInner() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { S.me = null; setAuthMode("login"); showView("auth"); endSplash(); return; }
    try {
      S.me = await rpc("me");
    } catch (e) {
      if (!S.me && $("denied").hidden) { if (e.code) { setAuthMode("login"); showView("auth"); aErr(errText(e)); } else { showView("auth"); aErr("Connexion à la base impossible. Réessaie."); } }
      endSplash(); return;
    }
    S.readOnly = S.me.role !== "admin";
    $("whoEmail").textContent = S.me.email + (S.readOnly ? " · lecteur" : "");
    showView("app"); renderDash();
    await refreshAll(false);
    const h = decodeURIComponent(location.hash.slice(1));
    if (h && S.sites.some(s => s.id === h)) openDetail(h);
  }

  if (!sb) {
    document.body.insertAdjacentHTML("beforeend", `<p style="padding:20px;text-align:center">Impossible de charger Supabase. Vérifie ta connexion puis recharge la page.</p>`);
    endSplash(); return;
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") { setAuthMode("newpw"); showView("auth"); endSplash(); }
    else if (event === "SIGNED_IN" && !S.me && authMode !== "newpw") boot();
    else if (event === "SIGNED_OUT") { S.me = null; }
  });
  boot();
})();

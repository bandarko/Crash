(function(){
  // ===== KONFIG =====
  const STATS_URL = "https://live.radiocrash.net/stats?json=1&sid=1";
  const TEXT_URL  = "https://live.radiocrash.net/currentsong?sid=1";
  const POLL_MS   = 12000;

  // Discogs primarno; YouTube je fallback
  const ENABLE_DISCOGS  = true;
  const DISCOGS_TOKEN   = ""; // TOKEN UKLONJEN - ne stavljati javno. Koristite server-side proxy ili env var.

  // ===== STATE =====
  let inflight = false;
  let lastDisplay = "";
  let lastLink    = "";
  let lastCover   = "";
  let timer = null;

  if (window.RCNP_TIMER) { try{ clearInterval(window.RCNP_TIMER); }catch(_){} }

  // ---------- helpers ----------
  function onReady(fn){
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once:true });
    } else { fn(); }
  }

  function youtubeSearchURL(artist, title){
    const q = encodeURIComponent(`${artist || ""} ${title || ""}`.trim());
    return `https://www.youtube.com/results?search_query=${q}`;
  }

  function normalizeArtistForDiscogs(artist){
    if (!artist) return "";
    const main = artist.split(/[\/,;&]/)[0];
    return main.trim();
  }

  function absolutizeDiscogsUrl(u){
    if (!u) return "";
    try {
      const apiMatch = String(u).match(/^https?:\/\/api\.discogs\.com\/(releases|masters|artists|labels)\/(\d+)/i);
      if (apiMatch) {
        const kind = apiMatch[1].toLowerCase();
        const id   = apiMatch[2];
        const map  = { releases: "release", masters: "master", artists: "artist", labels: "label" };
        return `https://www.discogs.com/${map[kind]}/${id}`;
      }
      return new URL(String(u), "https://www.discogs.com").href;
    } catch(_){
      return "";
    }
  }

  async function fetchWithTimeout(url, ms, opts){
    const ctl = ("AbortController" in window) ? new AbortController() : null;
    const t = setTimeout(()=>{ try{ ctl && ctl.abort(); }catch(_){} }, ms);
    try {
      const r = await fetch(url, Object.assign({ cache:"no-store", mode:"cors" }, opts||{}, { signal: ctl ? ctl.signal : undefined }));
      return r;
    } finally { clearTimeout(t); }
  }

  async function getNowPlaying(){
    try {
      const r = await fetchWithTimeout(STATS_URL + "&_=" + Date.now(), 2500, { headers:{Accept:"application/json"} });
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        if (j && (j.currentsong || j.songtitle)) return j.currentsong || j.songtitle;
      }catch(_){}
    }catch(_){}
    try {
      const r2 = await fetchWithTimeout(TEXT_URL + "&_=" + Date.now(), 2500, { headers:{Accept:"text/plain"} });
      const t2 = (await r2.text()).replace(/\s+/g," ").trim();
      if (t2) return t2;
    }catch(_){}
    return "";
  }

  function parseArtistTitle(raw){
    const cleaned = String(raw || "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const parts = cleaned.split(/\s*[-–—]\s*/);
    if (parts.length >= 2) {
      const artist = parts.shift().trim();
      let title = parts.join(" - ").trim();

      title = title.replace(/[\(\[\{]\s*.*?[\)\]\}]\s*$/g, "").trim();

      title = title
        .replace(/\?eta/ig, "beta")
        .replace(/β/ig, "beta")
        .replace(/''/g, '"')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");

      const display = `${artist} - ${title}`.trim();
      return { artist, title, display };
    }
    return { artist:"", title:"", display: cleaned };
  }

  function normalizeTitleForDiscogs(s){
    return String(s||"")
      .replace(/_/g, " ")
      .replace(/\?eta/ig, "beta")
      .replace(/β/ig, "beta")
      .replace(/''/g, '"')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s*medley:\s*/i, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titleVariants(title){
    const base = normalizeTitleForDiscogs(title);
    const withParenPart = base.replace(/\bpart\s*(\d+)\b/i, "(Part $1)");
    const withoutPart   = base.replace(/\bpart\s*\d+\b/i, "").replace(/\s+/g," ").trim();
    const colonized = base.replace(/\bp\s*[\s\-]\s*machinery\b/i, "P:Machinery");
    const dashed  = base.replace(/:/g, "-");
    const spaced  = base.replace(/:/g, " ");
    const noTrailingParens = base.replace(/\s*\(.*?\)\s*$/,"").trim();
    return Array.from(new Set(
      [base, withParenPart, withoutPart, colonized, dashed, spaced, noTrailingParens]
        .map(s => s.replace(/\s+/g," ").trim())
        .filter(Boolean)
    ));
  }

  async function discogsLookup(artist, title){
    if (!ENABLE_DISCOGS || !DISCOGS_TOKEN || !artist || !title) {
      return { link:"", cover:"" };
    }
    try {
      const mainArtist = normalizeArtistForDiscogs(artist);
      const variants = titleVariants(title);

      async function discogsSearch(paramsObj){
        const params = new URLSearchParams({ per_page: "20", token: DISCOGS_TOKEN, ...paramsObj });
        const url = `https://api.discogs.com/database/search?${params.toString()}`;
        const r = await fetchWithTimeout(url, 2500, { headers:{ Accept:"application/json" } });
        if (!r || !r.ok) return null;
        return r.json();
      }

      function pickBest(j, aNorm, tNorm){
        if (!j || !Array.isArray(j.results)) return null;
        const norm = s => String(s||"")
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g,"");

        const A = norm(aNorm);
        const T = norm(tNorm);
        const tokens = T.split(/\s+/).filter(w => w && !/^(the|and|of|to|a|an|in|on|for|mix|version|edit)$/i.test(w));

        let hit = j.results.find(it => {
          const tt = norm(it.title);
          return tt.includes(A) && tokens.every(tok => tt.includes(tok));
        });
        if (hit) return hit;

        hit = j.results.find(it => {
          const tt = norm(it.title);
          const matchCount = tokens.filter(tok => tt.includes(tok)).length;
          return tt.includes(A) && matchCount >= Math.max(1, Math.ceil(tokens.length/2));
        });
        if (hit) return hit;

        let best = null; let bestScore = 0;
        for (const it of j.results){
          const tt = norm(it.title);
          const score = tokens.filter(tok => tt.includes(tok)).length;
          if (score > bestScore){ bestScore = score; best = it; }
        }
        if (best && bestScore >= Math.max(1, Math.ceil(tokens.length/2))) return best;

        return null;
      }

      for (const v of variants){
        let j = await discogsSearch({ artist: mainArtist, track: v, type: "release" });
        let h = pickBest(j, mainArtist, v);

        if (!h){
          j = await discogsSearch({ artist: mainArtist, release_title: v, type: "release" });
          h = pickBest(j, mainArtist, v);
        }

        if (!h){
          j = await discogsSearch({ q: `${mainArtist} ${v}`, type: "master" });
          h = pickBest(j, mainArtist, v);
        }

        if (!h){
          j = await discogsSearch({ q: `${mainArtist} ${v}`, type: "release" });
          h = pickBest(j, mainArtist, v);
        }

        if (h){
          const raw = h.uri || h.resource_url || "";
          return {
            link:  absolutizeDiscogsUrl(raw),
            cover: h.cover_image || ""
          };
        }
      }
    } catch(_){}
    return { link:"", cover:"" };
  }

  function ensureTopBadge(){
    let el = document.getElementById("rcnp-top-badge");
    if (!el) {
      el = document.createElement("span");
      el.id = "rcnp-top-badge";
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function ensureFooter(){
    const container =
      document.querySelector('#qwPlayer') ||
      document.querySelector('.qw-player') ||
      document.querySelector('#colophon .site-info') ||
      document.querySelector('#colophon') ||
      document.querySelector('.site-footer') ||
      document.querySelector('footer') ||
      document.body;

    let el = document.getElementById('qwPlayerAuthor');
    if (!el) {
      el = document.createElement('div');
      el.id = 'qwPlayerAuthor';
      el.style.display = 'block';
      el.style.marginTop = '4px';
      el.style.position = 'relative';
      el.style.zIndex = 50;

      const label = document.createElement('span');
      label.className = 'np-label';
      label.textContent = 'Sada svira: ';
      const text = document.createElement('span');
      text.className = 'np-text';
      text.textContent = '…';
      el.replaceChildren(label, text);

      container.appendChild(el);
    }
    return el;
  }

  function setTop(display, link, cover){
    const top = ensureTopBadge();
    while (top.firstChild) top.removeChild(top.firstChild);

    if (cover) {
      const img = document.createElement('img');
      img.className = 'rcnp-cover';
      img.alt = '';
      img.src = cover;
      top.appendChild(img);
    }

    top.appendChild(document.createTextNode('Sada svira: '));

    if (link) {
      const a = document.createElement('a');
      a.id = 'rcnp-top-link';
      a.href = absolutizeDiscogsUrl(link);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(document.createTextNode(display || ""));
      top.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.id = 'rcnp-top-text';
      span.appendChild(document.createTextNode(display || ""));
      top.appendChild(span);
    }

    top.title = `Sada svira: ${display || ""}`;
  }

  function setFooter(display, link){
    const el = ensureFooter();
    let label = el.querySelector('.np-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'np-label';
      el.prepend(label);
    }
    label.textContent = 'Sada svira: ';

    let a = el.querySelector('#rcnp-footer-link');
    let span = el.querySelector('.np-text');

    if (link) {
      if (!a) {
        if (span) { span.remove(); span = null; }
        a = document.createElement('a');
        a.id = 'rcnp-footer-link';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        el.appendChild(a);
      }
      a.href = absolutizeDiscogsUrl(link);
      a.textContent = display || "";
    } else {
      if (!span) {
        if (a) { a.remove(); a = null; }
        span = document.createElement('span');
        span.className = 'np-text';
        el.appendChild(span);
      }
      span.textContent = display || "";
    }

    el.title = `Sada svira: ${display || ""}`;
    return true;
  }

  async function tick(){
    if (inflight) return;
    if (document.visibilityState === "hidden") return;
    inflight = true;
    try{
      const np = await getNowPlaying();
      if (!np) return;

      const { artist, title, display } = parseArtistTitle(np);
      if (!display) return;

      const changed = (display !== lastDisplay);
      const hasBoth = !!artist && !!title;

      if (changed){
        lastDisplay = display;
        lastLink    = "";
        lastCover   = "";
        setTop(display, "", "");
        setFooter(display, "");
      } else {
        setFooter(display, lastLink);
      }

      if (changed){
        const idle = window.requestIdleCallback || function(cb){ return setTimeout(cb, 0); };
        idle(async ()=>{
          let link = "", cover = "";
          if (hasBoth) {
            ({ link, cover } = await discogsLookup(artist, title));
          }
          if (!link) {
            link = youtubeSearchURL(artist, title || "");
            cover = "";
          }
          if (display !== lastDisplay) return;
          lastLink  = link;
          lastCover = cover;
          setTop(lastDisplay, lastLink, lastCover);
          setFooter(lastDisplay, lastLink);
        }, { timeout: 1200 });
      }
    } finally {
      inflight = false;
    }
  }

  onReady(()=>{
    ensureTopBadge();
    ensureFooter();
    setFooter('…', '');
    tick();
    timer = setInterval(()=>{
      const jitter = Math.floor(Math.random()*800)-400;
      setTimeout(tick, Math.max(0, 300 + jitter));
    }, POLL_MS);
    window.RCNP_TIMER = timer;
  });
})();
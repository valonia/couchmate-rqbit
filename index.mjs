// rqbit: the admin adds a magnet link or a .torrent file in the admin panel; its videos show in the apps. rqbit
// (a torrent client with TCP + uTP and HTTP streaming) downloads the one that plays and streams it while it
// downloads, the part being watched first – this plugin tells rqbit what to fetch and passes the stream on.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i;
const HASH = /^[a-f0-9]{40}$/;
const IDLE_MS = 15 * 60 * 1000; // a torrent nobody watches is paused after this long (stops uploading)

export default function setup(api) {
  const base = `/plugins/${api.id}`;
  const listFile = path.join(api.dataDir, 'torrents.json');
  const filesDir = path.join(api.dataDir, 'torrent-files');
  fs.mkdirSync(filesDir, { recursive: true });

  /** [{ hash, name, added, magnet?, files: [{ i, name, length }], playedAt? }] */
  let list = [];
  try { list = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch { /* none yet */ }
  const save = () => fs.writeFileSync(listFile, JSON.stringify(list, null, 1));
  const find = (hash) => list.find((t) => t.hash === hash);

  // ------------------------------------------------------------------ rqbit's HTTP API

  const rq = () => String(api.settings.url || 'http://host.docker.internal:3030').replace(/\/+$/, '');
  async function call(method, p, body, { timeout = 30000 } = {}) {
    const r = await fetch(rq() + p, { method, body, signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    if (!r.ok) throw new Error(`rqbit: ${text.slice(0, 200) || r.status}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  const sourceOf = (t) => {
    const file = path.join(filesDir, `${t.hash}.torrent`);
    return fs.existsSync(file) ? fs.readFileSync(file) : t.magnet;
  };

  /** What rqbit has: hash → { id, files included } (null when rqbit cannot be reached). */
  async function present() {
    try {
      const d = await call('GET', '/torrents', undefined, { timeout: 8000 });
      return new Map((d.torrents || []).map((x) => [x.info_hash, x]));
    } catch { return null; }
  }

  const used = new Map(); // hash → when it was last streamed
  let playingHash = null;

  /** Makes sure rqbit has the torrent and fetches file [i] (with the ones it already fetches) – and runs. */
  async function want(t, i) {
    used.set(t.hash, Date.now());
    let details = null;
    try { details = await call('GET', `/torrents/${t.hash}`); } catch { /* not in rqbit (yet) */ }
    if (!details) {
      await call('POST', `/torrents?overwrite=true&only_files=${i}`, sourceOf(t), { timeout: 120000 });
      return;
    }
    const included = (details.files || []).map((f, n) => (f.included ? n : -1)).filter((n) => n >= 0);
    if (!included.includes(i)) {
      await call('POST', `/torrents/${t.hash}/update_only_files`, JSON.stringify({ only_files: [...included, i] }));
    }
    const stats = await call('GET', `/torrents/${t.hash}/stats/v1`).catch(() => null);
    if (stats?.state === 'paused') await call('POST', `/torrents/${t.hash}/start`).catch(() => {});
  }

  api.on('state', ({ state }) => {
    const m = state.media;
    playingHash = m?.plugin === api.id ? (/^f:([a-f0-9]{40}):/.exec(m.id) || [])[1] || null : null;
    if (playingHash) used.set(playingHash, Date.now());
  });

  // Pause torrents nobody watches (no uploading in the background); over the disk limit, delete the downloads
  // of the ones watched longest ago (they download again if someone plays them).
  async function tidy() {
    const have = await present();
    if (!have) return;
    const max = Math.max(1, Number(api.settings.maxGB) || 60) * 1024 ** 3;
    let total = 0;
    const sizes = new Map();
    for (const [hash] of have) {
      const s = await call('GET', `/torrents/${hash}/stats/v1`).catch(() => null);
      sizes.set(hash, s);
      total += s?.progress_bytes || 0;
      const idle = hash !== playingHash && Date.now() - (used.get(hash) || 0) > IDLE_MS;
      if (idle && s && s.state !== 'paused') await call('POST', `/torrents/${hash}/pause`).catch(() => {});
    }
    const order = [...have.keys()].filter((h) => h !== playingHash)
      .sort((a, b) => (find(a)?.playedAt || 0) - (find(b)?.playedAt || 0));
    for (const hash of order) {
      if (total <= max) break;
      total -= sizes.get(hash)?.progress_bytes || 0;
      await call('POST', `/torrents/${hash}/delete`).catch(() => {});
      api.log(`[rqbit] removed the download of "${find(hash)?.name || hash}" to keep within ${api.settings.maxGB ?? 60} GB`);
    }
  }
  const sweep = setInterval(() => tidy().catch(() => {}), 5 * 60 * 1000);

  // ------------------------------------------------------------------ adding and removing

  /** Adds a torrent: rqbit only lists its files (nothing downloads until someone watches). */
  async function add(source, magnet) {
    const d = await call('POST', '/torrents?list_only=true', source, { timeout: 120000 });
    const info = d.details || d;
    const hash = String(info.info_hash || '').toLowerCase();
    if (!HASH.test(hash)) throw new Error('rqbit did not recognise that torrent');
    if (find(hash)) return find(hash);
    const t = {
      hash, name: info.name || hash, added: Date.now(), magnet: magnet || null,
      files: (info.files || []).map((f, i) => ({ i, name: f.name || (f.components || []).join('/'), length: f.length, padding: f.attributes?.padding || false }))
        .filter((f) => !f.padding).map(({ padding, ...f }) => f),
    };
    if (Buffer.isBuffer(source)) await fsp.writeFile(path.join(filesDir, `${hash}.torrent`), source);
    list.unshift(t);
    save();
    api.menuChanged();
    api.log(`[rqbit] added "${t.name}" (${videosOf(t).length} videos)`);
    return t;
  }

  async function remove(hash) {
    await call('POST', `/torrents/${hash}/delete`).catch(() => {});
    list = list.filter((t) => t.hash !== hash);
    save();
    await fsp.rm(path.join(filesDir, `${hash}.torrent`), { force: true }).catch(() => {});
    api.menuChanged();
  }

  // ------------------------------------------------------------------ items

  const clock = (sec) => {
    const s = Math.max(0, Math.round(sec));
    const two = (n) => String(n).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
  };

  // Release names: "Show.Name.S01E02.Episode.Name.1080p.WEB-DL…" → show, S01E02, episode name.
  const TAGS = /\b(2160p|1080p|720p|576p|480p|4k|uhd|web[- ]?dl|webrip|web|bluray|blu[- ]?ray|bdrip|brrip|hdtv|dvdrip|remux|hdr|x26[45]|h[ .]?26[45]|hevc|avc|amzn|nf|dsnp|hmax|atvp|ddp?\d|aac|ac3|dts|proper|repack|multi|complete)\b.*$/i;
  const tidyName = (s) => s.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').replace(TAGS, '').replace(/[\s\-[(]+$/, '').trim();
  const fileName = (p) => p.split(/[\\/]/).pop();
  function episodeOf(name) {
    const m = /^(.*?)[\s._-]*\bS(\d{1,2})[\s._-]?E(\d{1,3})\b[\s._-]*(.*)$/i.exec(fileName(name));
    if (!m) return null;
    return { show: tidyName(m[1]), season: Number(m[2]), episode: Number(m[3]), label: `S${m[2].padStart(2, '0')}E${m[3].padStart(2, '0')}`, name: tidyName(m[4]) };
  }

  /** A torrent's videos (no samples), in episode order when they are episodes, else by name. */
  function videosOf(t) {
    return t.files
      .filter((f) => VIDEO.test(f.name) && !/(^|[\\/._-])sample([\\/._-]|$)/i.test(f.name))
      .map((f) => ({ ...f, ep: episodeOf(f.name) }))
      .sort((a, b) => (a.ep && b.ep ? a.ep.season - b.ep.season || a.ep.episode - b.ep.episode : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }

  /** What the apps show: in the list (row) and while it plays (title, subtitle). */
  function itemOf(t, f, videos) {
    const id = `f:${t.hash}:${f.i}`;
    if (videos.length === 1) {
      const title = tidyName(t.name) || t.name;
      return { id, kind: 'movie', title, subtitle: null, row: title, rowSub: `${(f.length / 1024 ** 3).toFixed(1)} GB`, favorite: false };
    }
    const show = f.ep?.show || tidyName(t.name) || t.name;
    const name = f.ep ? [f.ep.label, f.ep.name].filter(Boolean).join(' · ') : tidyName(fileName(f.name));
    return { id, kind: f.ep ? 'episode' : 'movie', title: show, subtitle: name, row: name, rowSub: show, favorite: false };
  }

  function items() {
    const out = [];
    for (const t of list) {
      const videos = videosOf(t);
      for (const f of videos) out.push(itemOf(t, f, videos));
    }
    const w = typeof api.watched === 'function' ? api.watched(out.map((i) => i.id)) : {};
    for (const it of out) {
      const x = w[it.id];
      if (!x) continue;
      if (x.finished || (x.duration && x.duration - x.position < 300)) it.seen = true;
      else if (x.position >= 30) {
        it.resume = Math.round(x.position);
        it.resumeLabel = clock(x.position);
        if (x.duration) it.progress = Math.min(1, x.position / x.duration).toFixed(3);
      }
    }
    return out;
  }

  const parseId = (id) => {
    const m = /^f:([a-f0-9]{40}):(\d{1,5})$/.exec(id);
    const t = m && find(m[1]);
    const f = t?.files.find((x) => x.i === Number(m[2]));
    return f ? { t, f } : null;
  };

  // ------------------------------------------------------------------ the source

  api.source({
    name: 'rqbit',
    icon: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
    menu: async () => (list.length ? [{ id: 'home', title: 'rqbit' }] : []),
    // Films and episodes: ◀ ▶ skip, ▼ settings (audio, subtitles). Without this the player gets the keys for live.
    player: {
      keys: { ok: 'pause', up: 'info', down: 'settings', left: 'seek_back', right: 'seek_forward' },
      settings: [{ type: 'audio', title: api.t('Audio') }, { type: 'subtitles', title: api.t('Subtitles') }],
    },

    async view() {
      return {
        type: 'column',
        children: [
          { type: 'text', text: 'rqbit', style: 'title', padding: [0, 0, 10, 4] },
          {
            type: 'list', id: 'videos', weight: 1, items: items(), focus: 'row', itemHeight: 72,
            background: 'panel', radius: 12, padding: 8, autofocus: true,
            empty: api.t('Nothing here yet. Add a torrent on the rqbit page in the admin panel.'),
            onClick: { play: '{{item}}', position: '{{item.resume}}' },
            onLongClick: { play: '{{item}}', position: 0 },
            buttons: [{ text: api.t('↺ Start over'), onClick: { play: '{{item}}', position: 0 }, when: '{{item.resume}}' }],
            item: {
              type: 'row', align: 'center', children: [
                {
                  type: 'column', weight: 1, children: [
                    { type: 'text', text: '{{item.row}}', style: 'body', size: 17, maxLines: 1 },
                    { type: 'text', text: '{{item.rowSub}}', style: 'soft', size: 13, maxLines: 1 },
                    { type: 'progress', value: '{{item.progress}}', when: '{{item.progress}}', width: 360, padding: [0, 6, 0, 0] },
                  ],
                },
                { type: 'text', text: api.t('Continue from {time}', { time: '{{item.resumeLabel}}' }), style: 'body', size: 14, padding: [0, 0, 8, 0], when: '{{item.resume}}' },
                { type: 'text', text: '✓', color: 'accent', bold: true, size: 20, padding: [14, 0, 0, 0], when: '{{item.seen}}' },
              ],
            },
          },
        ],
      };
    },

    async resolve(id) {
      const hit = parseId(id);
      if (!hit) throw new Error('This torrent has been removed');
      const { t, f } = hit;
      t.playedAt = Date.now();
      save();
      const videos = videosOf(t);
      const it = itemOf(t, videos.find((x) => x.i === f.i) || f, videos);
      return { url: `${base}/stream/${t.hash}/${f.i}`, type: 'file', live: false, kind: it.kind, title: it.title, subtitle: it.subtitle };
    },

    /** The next video in the same torrent (the next episode) – the server shows "next episode" and plays it. */
    async next(id) {
      const hit = parseId(id);
      if (!hit) return null;
      const videos = videosOf(hit.t);
      const at = videos.findIndex((x) => x.i === hit.f.i);
      if (at < 0 || at + 1 >= videos.length) return null;
      const { row, rowSub, ...item } = itemOf(hit.t, videos[at + 1], videos);
      return item;
    },
  });

  // ------------------------------------------------------------------ streaming to the apps

  // MKV and MP4 files often keep their index (Cues / moov) at the end. The players read it when the video opens –
  // without it they cannot seek at all. rqbit fetches from the start, so the end is fetched first, once per file.
  const TAIL = 12 * 1024 * 1024;
  const tails = new Map(); // "hash:i" → Promise
  function tailFirst(t, f) {
    const key = `${t.hash}:${f.i}`;
    if (!tails.has(key)) {
      const from = Math.max(0, f.length - TAIL);
      const job = (async () => {
        const r = await fetch(`${rq()}/torrents/${t.hash}/stream/${f.i}`, { headers: { range: `bytes=${from}-${f.length - 1}` }, signal: AbortSignal.timeout(90000) });
        if (r.body) for await (const chunk of r.body) void chunk; // read it all: rqbit has then downloaded it
      })().catch((e) => { tails.delete(key); api.log(`[rqbit] ${t.name}: the end of the file could not be fetched first – ${e.message}`); });
      tails.set(key, job);
    }
    return tails.get(key);
  }

  api.route('GET', '/stream/*', async (req, res, { path: rest }) => {
    const m = /^([a-f0-9]{40})\/(\d{1,5})$/.exec(rest);
    const hit = m && parseId(`f:${m[1]}:${m[2]}`);
    if (!hit) { res.writeHead(404); return res.end(); }
    try {
      await want(hit.t, hit.f.i);
    } catch (e) {
      api.log(`[rqbit] ${hit.t.name}: ${e.message}`);
      res.writeHead(502); return res.end();
    }
    await tailFirst(hit.t, hit.f);
    // rqbit holds the response until the requested part has downloaded, fetching it first.
    api.proxy(req, res, `${rq()}/torrents/${hit.t.hash}/stream/${hit.f.i}`);
  });

  // ------------------------------------------------------------------ the page in the admin panel

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const gb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, (n || 0) / 1024 ** 2).toFixed(0)} MB`);

  const html = (res, body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>rqbit</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;background:#0f1115;color:#e8eaf0}
a{color:#7aa2ff}.card{background:#181b22;border-radius:12px;padding:16px 18px;margin:14px 0}.dim{color:#9aa0ad}.err{color:#ff7a7a}
.btn{display:inline-block;background:#2a2f3a;color:#e8eaf0;border:0;border-radius:20px;padding:9px 18px;font-weight:600;cursor:pointer;font-size:15px;text-decoration:none}
.btn.small{padding:5px 12px;font-size:13px}.btn.blue{background:#3d7bff;color:#fff}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #262b35}.row:last-child{border-bottom:0}.grow{flex:1;min-width:0}
.grow b{word-break:break-word}
textarea{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #333a48;background:#0f1115;color:#e8eaf0;font:13px monospace}
.bar{height:4px;background:#262b35;border-radius:4px;margin-top:6px}.bar i{display:block;height:100%;background:#3d7bff;border-radius:4px;transition:width .5s}
.live{margin-top:8px}.stat{display:inline-block;margin-right:14px;font-variant-numeric:tabular-nums}
.eps{margin-top:8px}.ep{display:grid;grid-template-columns:90px 1fr 44px;gap:10px;align-items:center;font-size:13px;font-variant-numeric:tabular-nums}.ep .bar{margin:0}
</style></head><body><h1>rqbit</h1>${body}
<script>
document.getElementById('file')?.addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x);
  const r = await fetch('${base}/add-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: btoa(s) }) });
  location.href = '${base}/admin' + (r.ok ? '' : '?error=' + encodeURIComponent(await r.text()));
});
</script></body></html>`);
  };
  const back = (res, error) => { res.writeHead(303, { location: `${base}/admin${error ? `?error=${encodeURIComponent(error)}` : ''}` }); res.end(); };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
  });

  /** Live status for the admin page: speed, peers and how far each video got. */
  api.route('GET', '/status', async (req, res) => {
    const have = await present();
    const out = { reachable: Boolean(have), torrents: {} };
    for (const t of list) {
      if (!have?.has(t.hash)) continue;
      const [s, d] = await Promise.all([
        call('GET', `/torrents/${t.hash}/stats/v1`).catch(() => null),
        call('GET', `/torrents/${t.hash}`).catch(() => null),
      ]);
      if (!s) continue;
      const p = s.live?.snapshot?.peer_stats || {};
      const mib = (x) => Math.round((x?.mbps || 0) * 1048576);
      const included = new Set((d?.files || []).map((f, n) => (f.included ? n : -1)).filter((n) => n >= 0));
      const wanted = t.files.filter((f) => included.has(f.i)).reduce((n, f) => n + f.length, 0);
      const done = t.files.filter((f) => included.has(f.i)).reduce((n, f) => n + Math.min(f.length, s.file_progress?.[f.i] || 0), 0);
      const down = s.state === 'live' ? mib(s.live?.download_speed) : 0;
      out.torrents[t.hash] = {
        state: s.state, peers: p.live || 0, tcp: p.live_tcp || 0, utp: p.live_utp || 0, down,
        up: s.state === 'live' ? mib(s.live?.upload_speed) : 0, uploaded: s.uploaded_bytes || 0,
        done, wanted, eta: down > 0 && wanted > done ? Math.round((wanted - done) / down) : null,
        files: videosOf(t).map((f) => ({ label: f.ep?.label || tidyName(fileName(f.name)), done: Math.min(f.length, s.file_progress?.[f.i] || 0), length: f.length, wanted: included.has(f.i) })),
      };
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
  }, { auth: 'admin' });

  api.route('GET', '/admin', async (req, res, { query }) => {
    const have = await present();
    const rows = [];
    for (const t of list) {
      const videos = videosOf(t);
      const size = t.files.reduce((n, f) => n + f.length, 0);
      rows.push(`<div class="row"><span class="grow"><b>${esc(t.name)}</b><br><span class="dim">${videos.length} video${videos.length === 1 ? '' : 's'} · ${gb(size)}</span>
        <div class="live" id="s-${t.hash}"><span class="dim">Not downloading – starts when someone watches.</span></div><div class="eps" id="e-${t.hash}"></div></span>
        <form method="post" action="${base}/remove"><input type="hidden" name="hash" value="${esc(t.hash)}"><button class="btn small">Remove</button></form></div>`);
    }
    html(res, `${query.get('error') ? `<p class="err">${esc(query.get('error'))}</p>` : ''}
      ${have ? '' : `<p class="err">rqbit cannot be reached at ${esc(rq())} – is it running? (the plugin's settings)</p>`}
      <div class="card"><b>Add a torrent</b>
        <form method="post" action="${base}/add"><p><textarea name="magnet" rows="3" placeholder="magnet:?xt=urn:btih:…" required></textarea></p>
        <p><button class="btn blue" type="submit">Add magnet link</button></p></form>
        <p>…or a .torrent file: <input type="file" id="file" accept=".torrent,application/x-bittorrent"></p>
        <p class="dim">Its videos show under <b>rqbit</b> in the apps. Nothing downloads until someone watches; then the part being
        watched comes first. Only add torrents you have the right to download – a torrent uploads to others while it downloads.</p></div>
      <div class="card"><b>Added</b>${rows.join('') || '<p class="dim">None yet.</p>'}
        <p class="dim">Downloads use at most ${esc(api.settings.maxGB ?? 60)} GB (the plugin's settings) – the ones watched longest ago are removed first.
        Torrents nobody has watched for 15 minutes are paused, so they stop uploading. This page updates itself.</p></div>
      <script>
      const size = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : (n / 1048576).toFixed(0) + ' MB';
      const speed = (n) => (n / 1048576).toFixed(1) + ' MB/s';
      const time = (s) => s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round(s / 60) % 60 + ' min' : s >= 60 ? Math.round(s / 60) + ' min' : s + ' s';
      const STATE = { live: 'Downloading', paused: 'Paused', initializing: 'Checking', error: 'Error' };
      async function poll() {
        try {
          const d = await (await fetch('${base}/status', { cache: 'no-store' })).json();
          for (const [hash, s] of Object.entries(d.torrents)) {
            const box = document.getElementById('s-' + hash), eps = document.getElementById('e-' + hash);
            if (!box) continue;
            const pct = s.wanted ? (100 * s.done / s.wanted) : 0;
            const finished = s.wanted && s.done >= s.wanted;
            box.innerHTML = '<span class="stat"><b>' + (finished ? 'Downloaded' : (STATE[s.state] || s.state)) + '</b></span>'
              + (s.state === 'live' ? '<span class="stat">↓ <b>' + speed(s.down) + '</b></span><span class="stat">↑ ' + speed(s.up) + '</span>'
                + '<span class="stat">' + s.peers + ' peers <span class="dim">(' + s.tcp + ' TCP, ' + s.utp + ' uTP)</span></span>' : '')
              + '<span class="stat">' + size(s.done) + ' of ' + size(s.wanted) + ' (' + pct.toFixed(0) + ' %)</span>'
              + (s.eta && !finished ? '<span class="stat dim">about ' + time(s.eta) + ' left</span>' : '')
              + '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
            eps.innerHTML = s.files.length > 1 ? s.files.filter((f) => f.wanted || f.done > 0).map((f) =>
              '<div class="ep"><span>' + f.label + '</span><div class="bar"><i style="width:' + (100 * f.done / f.length).toFixed(1) + '%"></i></div><span class="dim">' + (100 * f.done / f.length).toFixed(0) + ' %</span></div>').join('') : '';
          }
        } catch {}
      }
      poll(); setInterval(poll, 2000);
      </script>`);
  }, { auth: 'admin' });

  api.route('POST', '/add', async (req, res) => {
    try {
      const magnet = new URLSearchParams(await readBody(req, 20000)).get('magnet')?.trim() || '';
      if (!/^magnet:\?/i.test(magnet) || !/xt=urn:btih:/i.test(magnet)) throw new Error('That is not a magnet link (magnet:?xt=urn:btih:…)');
      await add(magnet, magnet);
      back(res);
    } catch (e) { back(res, e.message); }
  }, { auth: 'admin' });

  api.route('POST', '/add-file', async (req, res) => {
    try {
      const { data } = JSON.parse(await readBody(req, 8 * 1024 * 1024));
      await add(Buffer.from(String(data), 'base64'));
      res.writeHead(200); res.end('ok');
    } catch (e) { res.writeHead(400); res.end(e.message || 'Not a torrent file'); }
  }, { auth: 'admin' });

  api.route('POST', '/remove', async (req, res) => {
    const hash = new URLSearchParams(await readBody(req, 2000)).get('hash') || '';
    if (HASH.test(hash)) await remove(hash);
    back(res);
  }, { auth: 'admin' });

  api.link('rqbit', `${base}/admin`);

  return () => clearInterval(sweep);
}

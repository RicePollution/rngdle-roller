// RNGdle roller dashboard — zero dependencies (Node 18+).
//   node server.js            -> http://localhost:4321/__roller/
// It serves the dashboard and proxies rngdle.com under the same localhost origin,
// so the dashboard can drive the real site in a hidden iframe and read its rolls.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4321;
const UPSTREAM = 'https://rngdle.com';
const DASH = fs.readFileSync(path.join(__dirname, 'index.html'));
const STRIP = new Set(['content-encoding', 'content-length', 'set-cookie', 'transfer-encoding', 'connection',
  'content-security-policy', 'x-frame-options', 'strict-transport-security', 'alt-svc', 'report-to', 'nel']);
const cache = new Map();

// Engine mode: the dashboard loads the site in an iframe on the *other* local hostname
// (localhost <-> 127.0.0.1) with ?_engine=1&_p=<dashboard origin>. This script is injected
// into that page only. It clears today's guest roll before the app boots, clicks Generate,
// and posts the saved roll to the dashboard, which replies "again" for the next roll.
const ENGINE_PARENT = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
const ENGINE_HOST = /^e\d+g[01]\.localhost(:\d+)?$/;
const engineScript = (parent) => `<script>(function(){
  if (window.top === window) return;
  var PARENT = ${JSON.stringify(parent)};
  var K = ['rngdle_guest_roll_date','rngdle_guest_roll_data','rngdle_guest_claim_token'];
  K.forEach(function(k){ localStorage.removeItem(k); });
  // Driven by DOM changes rather than timers, which browsers slow down in background frames.
  var clicked = false, sent = false, mo = null;
  function send(m){ if (sent) return; sent = true; if (mo) mo.disconnect(); parent.postMessage(m, PARENT); }
  function check(){
    if (sent) return;
    if (!clicked) {
      var b = document.querySelector('button[aria-label="Generate a new number"]');
      if (!b) return;
      clicked = true; b.click();
    }
    var d = localStorage.getItem(K[1]);
    if (d) {
      var date = localStorage.getItem(K[0]);
      K.forEach(function(k){ localStorage.removeItem(k); }); // leave nothing behind on this origin
      send({ rr: 'roll', raw: d, date: date });
    }
  }
  function waitBtn(){
    mo = new MutationObserver(check);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    check();
    setTimeout(function(){
      send(clicked
        ? { rr: 'error', message: "The roll wasn't saved. The site may have changed how guest rolls are stored." }
        : { rr: 'error', message: "Couldn't find the Generate button. The site may have changed." });
    }, 12000);
  }
  addEventListener('message', function(e){
    if (e.origin !== PARENT || !e.data || e.data.rr !== 'again') return;
    location.replace('/?_engine=1&_p=' + encodeURIComponent(PARENT) + '&_r=' + Date.now());
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitBtn); else waitBtn();
})();</script>`;

function cacheKey(url) {
  const u = new URL(url, 'http://x');
  ['_r', '_engine', '_p'].forEach((p) => u.searchParams.delete(p));
  return u.pathname + (u.search || '');
}

async function fetchUpstream(url, ua) {
  const up = await fetch(UPSTREAM + url, {
    headers: { 'user-agent': ua || 'Mozilla/5.0', accept: '*/*' },
    redirect: 'follow',
  });
  const headers = {};
  up.headers.forEach((v, k) => { if (!STRIP.has(k)) headers[k] = v; });
  if (url.startsWith('/_next/static/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
  else headers['cache-control'] = 'no-store';
  return { ok: up.ok, status: up.status, headers, body: Buffer.from(await up.arrayBuffer()), at: Date.now() };
}

const server = http.createServer(async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const engineParent = q.get('_engine') === '1' && ENGINE_PARENT.test(q.get('_p') || '') ? q.get('_p') : null;
  const send = (r) => {
    let body = r.body;
    if (engineParent && /text\/html/.test(r.headers['content-type'] || '')) {
      body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + engineScript(engineParent)));
    }
    res.writeHead(r.status, r.headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  if (req.url === '/__roller' || req.url.startsWith('/__roller/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(DASH);
  }
  const pathname = req.url.split('?')[0];
  // The site's service worker sits in front of every reroll and slows it down; don't let it install here.
  if (pathname === '/sw.js') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(); }
  // Engine pages (eNgM.localhost) only need the app code to roll: skip fonts, images and the
  // site's API calls so each reroll loads less.
  if (ENGINE_HOST.test(req.headers.host || '')) {
    if (/\.(woff2?|ttf|otf|png|jpe?g|gif|webp|avif|ico|svg|webmanifest)$/i.test(pathname)) {
      res.writeHead(404, { 'cache-control': 'public, max-age=31536000' }); return res.end();
    }
    if (pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{}');
    }
  }
  // Only reads are proxied. Guest rolls never touch the server, so nothing else is needed.
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(204); return res.end(); }

  // Hashed build files are cached forever. Everything else (page HTML, stats) is served from memory
  // instantly and refreshed in the background once it's 60s old, so a reroll never waits on rngdle.com.
  const isStatic = req.url.startsWith('/_next/static/');
  const key = cacheKey(req.url);
  const hit = cache.get(key);
  if (hit) {
    if (!isStatic && Date.now() - hit.at > 60000 && !hit.refreshing) {
      hit.refreshing = true;
      fetchUpstream(key, req.headers['user-agent'])
        .then((n) => { if (n.ok) cache.set(key, n); })
        .catch(() => {})
        .finally(() => { hit.refreshing = false; });
    }
    return send(hit);
  }
  try {
    const n = await fetchUpstream(key, req.headers['user-agent']);
    if (n.ok) cache.set(key, n);
    send(n);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Could not reach rngdle.com: ' + e.message);
  }
});

// Loopback only (IPv4 and IPv6): browsers may reach localhost and *.localhost over either.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`RNGdle roller running at http://localhost:${PORT}/__roller/`);
});
const server6 = http.createServer((req, res) => server.emit('request', req, res));
server6.on('error', () => {}); // no IPv6 loopback on this machine: IPv4 alone is fine
server6.listen(PORT, '::1');

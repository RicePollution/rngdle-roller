// RNGdle auto-roller
// Paste into the DevTools console on https://rngdle.com (while signed OUT — guest rolls only).
// Rerolls in a hidden iframe until your roll is in the top GOAL_TOP_PERCENT %, then shows it.
// Change the goal in the panel (or below) at any time. Stop keeps the best roll found so far.
(async () => {
  const GOAL_TOP_PERCENT = 5;   // default goal: "Top 5%"
  const MAX_ROLLS = 20000;      // safety cap

  const K_DATE = 'rngdle_guest_roll_date';
  const K_DATA = 'rngdle_guest_roll_data';
  const K_CLAIM = 'rngdle_guest_claim_token';
  const BTN = 'button[aria-label="Generate a new number"]';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (window.__rngRoller) { window.__rngRoller.stop(); await sleep(200); }

  // ---- Load the site's own score -> percentile table so "Top X%" matches the site exactly ----
  async function loadPercentiles() {
    const urls = [...new Set([
      ...[...document.scripts].map((s) => s.src),
      ...performance.getEntriesByType('resource').map((e) => e.name),
    ])].filter((u) => /\/_next\/static\/chunks\/.+\.js/.test(u));
    const marker = '"SCORE_PERCENTILES",0,{';
    for (const u of urls) {
      const src = await fetch(u).then((r) => r.text()).catch(() => '');
      const i = src.indexOf(marker);
      if (i < 0) continue;
      const start = i + marker.length - 1;
      const literal = src.slice(start, src.indexOf('}', start) + 1);
      if (!/^\{[0-9a-fx:.,+\-]*\}$/.test(literal)) continue; // numeric literals only (incl. hex keys), then evaluate
      const obj = new Function('return ' + literal)();
      const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
      return { obj, keys };
    }
    return null;
  }
  const table = await loadPercentiles();
  // Fallback thresholds (min EP) if the table can't be found after a site update
  const FALLBACK = [[50, 5802], [25, 10074], [10, 22293], [5, 35469], [1, 162292], [0.1, 1054023]];

  function percentileFor(score) { // same lookup the site uses
    if (!table) return null;
    const { obj, keys } = table;
    let lo = 0, hi = keys.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= score) { best = m; lo = m + 1; } else hi = m - 1; }
    return best < 0 ? 0 : obj[keys[best]];
  }
  function thresholdFor(topPct) {
    const need = 100 - topPct;
    if (table) { const k = table.keys.find((k) => table.obj[k] >= need); return k ?? Infinity; }
    const f = FALLBACK.filter(([t]) => t <= topPct).sort((a, b) => b[0] - a[0])[0];
    return f ? f[1] : FALLBACK[FALLBACK.length - 1][1];
  }
  const topText = (score) => { const p = percentileFor(score); return p == null ? '?' : `Top ${+(100 - p).toFixed(4)}%`; };

  // ---- UI panel ----
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;width:260px;padding:12px;border-radius:10px;background:#111;color:#eee;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">🎲 RNGdle roller</div>
    <label>Goal: Top <input id="rr-goal" type="number" min="0.0001" max="100" step="any" value="${GOAL_TOP_PERCENT}" style="width:70px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:2px 4px">%</label>
    <div id="rr-thr" style="opacity:.7;margin:2px 0 6px"></div>
    <div id="rr-stat">Starting…</div>
    <div id="rr-best" style="opacity:.85"></div>
    <button id="rr-stop" style="margin-top:8px;width:100%;padding:6px;border:0;border-radius:6px;background:#c33;color:#fff;font-weight:600;cursor:pointer">Stop (keep best)</button>`;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector(id);
  let goal = GOAL_TOP_PERCENT, threshold = thresholdFor(goal);
  const showThr = () => { $('#rr-thr').textContent = `needs ≥ ${threshold.toLocaleString()} EP${table ? '' : ' (fallback table)'}`; };
  showThr();
  $('#rr-goal').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0 && v <= 100) { goal = v; threshold = thresholdFor(goal); showThr(); }
  });

  // ---- Roller ----
  // The iframe is replaced every 25 rolls: reusing one forever lets old page copies pile up
  // and each roll gets slower.
  const makeFrame = () => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:400px;height:700px;left:-10000px;top:0;opacity:0;pointer-events:none';
    return f;
  };
  let iframe = makeFrame(), frameUses = 0;
  document.body.appendChild(iframe);

  let running = true, rolls = 0, best = null;
  const t0 = performance.now();
  const stop = () => { running = false; };
  window.__rngRoller = { stop };
  $('#rr-stop').onclick = stop;

  const readRoll = () => { try { return JSON.parse(localStorage.getItem(K_DATA)); } catch { return null; } };
  const clearRoll = () => [K_DATE, K_DATA, K_CLAIM].forEach((k) => localStorage.removeItem(k));
  const saveRoll = (r) => { localStorage.setItem(K_DATE, r.date); localStorage.setItem(K_DATA, r.raw); };

  function loadFrame() {
    if (frameUses >= 25) { const f = makeFrame(); iframe.replaceWith(f); iframe = f; frameUses = 0; }
    frameUses++;
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('iframe load timeout')), 15000);
      iframe.onload = () => { clearTimeout(to); res(); };
      const url = '/?_r=' + Date.now();
      const w = iframe.contentWindow;
      if (w && w.location.href !== 'about:blank') w.location.replace(url); else iframe.src = url;
    });
  }
  async function waitFor(fn, ms, step = 25) {
    const end = performance.now() + ms;
    while (performance.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  // Count today's existing roll (if any) as the first candidate
  const existing = readRoll();
  if (existing && localStorage.getItem(K_DATE)) {
    best = { score: existing.totalScore, number: existing.number, raw: localStorage.getItem(K_DATA), date: localStorage.getItem(K_DATE) };
  }

  let hit = best && best.score >= threshold ? best : null;
  try {
    while (running && !hit && rolls < MAX_ROLLS) {
      clearRoll();
      await loadFrame();
      const btn = await waitFor(() => iframe.contentDocument?.querySelector(BTN), 10000);
      if (!btn) throw new Error('GENERATE button not found (signed in, or site changed?)');
      btn.click();
      const r = await waitFor(() => localStorage.getItem(K_DATA) && readRoll(), 3000, 10);
      if (!r) throw new Error('Roll was not saved to localStorage (are you signed in?)');
      rolls++;
      const cur = { score: r.totalScore, number: r.number, raw: localStorage.getItem(K_DATA), date: localStorage.getItem(K_DATE) };
      if (!best || cur.score > best.score) best = cur;
      if (cur.score >= threshold) hit = cur;
      const secs = (performance.now() - t0) / 1000;
      $('#rr-stat').textContent = `Roll ${rolls}: ${cur.number.toLocaleString()} → ${cur.score.toLocaleString()} EP (${topText(cur.score)}) · ${(rolls / secs).toFixed(1)}/s`;
      $('#rr-best').textContent = `Best: ${best.number.toLocaleString()} · ${best.score.toLocaleString()} EP (${topText(best.score)})`;
    }
  } catch (e) {
    $('#rr-stat').textContent = '⚠️ ' + e.message;
    console.error('[rngdle-roller]', e);
  }

  iframe.remove();
  const keep = hit || best;
  if (keep) { clearRoll(); saveRoll(keep); }
  const msg = hit
    ? `✅ Hit ${topText(hit.score)} after ${rolls} rolls: ${hit.number.toLocaleString()} (${hit.score.toLocaleString()} EP). Reloading…`
    : keep ? `Stopped after ${rolls} rolls. Kept best: ${keep.number.toLocaleString()} (${topText(keep.score)}). Reloading…`
           : `Stopped after ${rolls} rolls.`;
  $('#rr-stat').textContent = msg;
  console.log('[rngdle-roller]', msg);
  if (keep) setTimeout(() => location.reload(), 1500);
})();

// Re-capture the README screenshots without adding a browser dependency.
//
// Uses the Chromium that Playwright already cached under ~/.cache/ms-playwright,
// driven over raw CDP with Node's global WebSocket. Do NOT run `npm run dev`
// for this: boot() calls runCycle() and re-dispatches every failed episode.
// Use the vite dev proxy instead (new UI, real data, zero writes).
//
//   npx vite --port 5173          # proxy /api -> live backend on 8282
//   node scripts/screenshots.mjs  [names...]
//
// The bulk-delete guard needs >=5 episodes. If the live DB holds fewer, shoot it
// against the mock backend instead:
//   npm run mock                              # mock backend on 8399
//   API_PROXY_TARGET=http://localhost:8399 npx vite --port 5174
//   SHOT_URL=http://localhost:5174/ node scripts/screenshots.mjs bulk-remove-guard
//
// Set CDP_PORT to reuse a browser you already have running.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "screenshots");
const SITE = process.env.SHOT_URL ?? "http://localhost:5173/";
const CDP = `http://localhost:${process.env.CDP_PORT ?? 9222}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let seq = 0;
const pending = new Map();
let chromeProc = null;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}

function send(method, params = {}, ms = 20000) {
  const id = ++seq;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return withTimeout(p, ms, method);
}

async function findChrome() {
  const root = path.join(process.env.HOME ?? "", ".cache", "ms-playwright");
  const dirs = (await fs.promises.readdir(root).catch(() => [])).filter((d) => d.startsWith("chromium-"));
  for (const d of dirs) {
    const bin = path.join(root, d, "chrome-linux64", "chrome");
    if (fs.existsSync(bin)) return bin;
  }
  const which = process.env.CHROME_BIN;
  if (which && fs.existsSync(which)) return which;
  throw new Error(`no chromium under ${root}; set CHROME_BIN`);
}

async function ensureBrowser() {
  const reachable = await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false);
  if (!reachable) {
    const bin = await findChrome();
    const { spawn } = await import("node:child_process");
    const dir = await fs.promises.mkdtemp("/tmp/op-screenshots-");
    // Flags must use `=`, not a space: with `--remote-debugging-port 9222` Chrome
    // reads the port as a positional target and dies with
    // "Multiple targets are not supported in headless mode".
    chromeProc = spawn(bin, [
      "--headless=new", "--no-sandbox", "--disable-gpu",
      `--remote-debugging-port=${new URL(CDP).port}`,
      `--user-data-dir=${dir}`,
    ], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false)) break;
    }
    if (!(await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false))) {
      throw new Error(`chromium did not start listening on ${CDP}`);
    }
  }
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const target = list.find((t) => t.type === "page")
    ?? await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  }), 10000, "ws open");
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    throw new Error("page error: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  return r.result.value;
}

async function setViewport(width, height, dsf = 2, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile });
}

async function goto(url, waitMs = 5500) {
  const loaded = new Promise((resolve) => {
    const h = (ev) => {
      if (JSON.parse(ev.data).method === "Page.loadEventFired") {
        ws.removeEventListener("message", h);
        resolve();
      }
    };
    ws.addEventListener("message", h);
    setTimeout(resolve, waitMs + 8000);
  });
  await send("Page.navigate", { url });
  await loaded;
  await sleep(waitMs);
}

/** daisyUI modals are class-toggled divs, not [open] dialogs. */
async function dismissOverlays() {
  await evaluate(`
    (() => {
      for (const b of document.querySelectorAll('.modal-backdrop')) b.click();
      for (const m of document.querySelectorAll('.modal.modal-open')) m.classList.remove('modal-open');
    })()
  `);
}

async function pageMetrics() {
  return JSON.parse(await evaluate(`JSON.stringify({
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
  })`));
}

/** Grows the viewport to the full page so position:sticky settles once. */
async function shot(name, { full = false, scale = 1 } = {}) {
  const params = { format: "png", captureBeyondViewport: false };
  if (full) {
    let m = await pageMetrics();
    await setViewport(m.scrollW, m.scrollH, 2, false);
    await sleep(900);
    m = await pageMetrics();
    if (scale !== 1) params.clip = { x: 0, y: 0, width: m.scrollW, height: m.scrollH, scale };
  }
  const { data } = await send("Page.captureScreenshot", params, 30000);
  const file = path.join(OUT, name);
  await fs.promises.writeFile(file, Buffer.from(data, "base64"));
  return file;
}

const clickText = (re) => evaluate(`
  (() => {
    const rx = new RegExp(${JSON.stringify(re)});
    const b = [...document.querySelectorAll('button')].find((x) => rx.test((x.textContent ?? '').trim()));
    if (!b) return 'NOT FOUND: ' + ${JSON.stringify(re)};
    b.click();
    return 'clicked';
  })()
`);

async function boot(theme, width = 1440, height = 900) {
  await setViewport(width, height, 2, false);
  await goto(SITE);
  await dismissOverlays();
  await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
  await sleep(800);
}

// Credential masking for the settings shot. The settings dialog binds each
// input to the *stored* value (Settings.svelte seeds `edited[key] = s.value`),
// so it renders API keys and webhook URLs in plain text. Capturing that would
// publish live credentials in the README, so mask every credential-shaped field
// before the shutter. Cosmetic only — never persists, never saves.
const REDACT = `
(async () => {
  const raw = await (await fetch('/api/settings')).json();
  const list = Array.isArray(raw) ? raw : (raw.settings ?? []);
  const isSecret = (v) => {
    if (!v || v.length < 12) return false;
    // A URL is only a credential when it embeds a token; a plain URL is public.
    if (/^https?:\\/\\//.test(v)) return /webhooks\\/|\\/tokens?\\/|token=|key=|secret=/i.test(v);
    return true;
  };
  const secrets = new Set(list.filter((s) => isSecret(s.value)).map((s) => s.value));
  const mask = (v) => (v.length ? v.slice(0, 4) + "…" + "•".repeat(Math.min(v.length - 5, 20)) : v);
  let n = 0;
  for (const input of document.querySelectorAll('dialog.modal input, dialog.modal textarea')) {
    if (secrets.has(input.value)) { input.value = mask(input.value); n++; }
  }
  // Any place the value leaked into rendered text.
  for (const el of document.querySelectorAll('dialog.modal *')) {
    if (el.children.length !== 0) continue;
    for (const s of secrets) {
      if (el.textContent && el.textContent.includes(s)) {
        el.textContent = el.textContent.replaceAll(s, mask(s));
        n++;
      }
    }
  }
  return n;
})()
`;

const SHOTS = {
  async dashboard() {
    await boot("dark");
    return shot("dashboard.png");
  },
  async "dashboard-light"() {
    await boot("light");
    return shot("dashboard-light.png");
  },
  async "dashboard-full"() {
    await boot("dark");
    return shot("dashboard-full.png", { full: true });
  },
  async settings() {
    await boot("dark");
    await evaluate(`document.querySelector('header button[aria-label="Settings"]').click()`);
    await sleep(900);
    const masked = await evaluate(REDACT, true);
    console.log(`  masked ${masked} credential field(s)`);
    return shot("settings.png");
  },
  async "library-missing"() {
    await boot("dark");
    await clickText("S00 Specials");
    await sleep(1000);
    return shot("library-missing.png", { full: true });
  },
  async "episodes-selection"() {
    await boot("dark");
    await evaluate(`document.querySelector('input[aria-label="Select all episodes"]')?.click()`);
    await sleep(700);
    await evaluate(`
      (() => {
        const h = [...document.querySelectorAll('h2')].find((e) => e.textContent.trim().startsWith('Episodes'));
        if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 80);
      })()
    `);
    await sleep(700);
    return shot("episodes-selection.png");
  },
  async "bulk-remove-guard"() {
    await boot("dark");
    await evaluate(`document.querySelector('input[aria-label="Select all episodes"]')?.click()`);
    await sleep(700);
    await clickText("^Remove \\(\\d+\\)$");
    await sleep(900);
    await evaluate(`
      (() => {
        const cb = document.querySelector('.modal.modal-open input[type=checkbox]');
        if (cb && !cb.checked) cb.click();
      })()
    `);
    await sleep(700);
    return shot("bulk-remove-guard.png");
  },
  async "dashboard-mobile"() {
    await setViewport(492, 900, 2, false);
    await goto(SITE);
    await dismissOverlays();
    await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await sleep(800);
    // Tall narrow pages need a reduced clip scale.
    return shot("dashboard-mobile.png", { full: true, scale: 0.5 });
  },
};

async function main() {
  const only = process.argv.slice(2);
  await ensureBrowser();
  const names = only.length ? only : Object.keys(SHOTS);
  for (const n of names) {
    if (!SHOTS[n]) {
      console.log(`?? unknown shot: ${n}`);
      continue;
    }
    const t0 = Date.now();
    const file = await SHOTS[n]();
    console.log(`${n} -> ${path.relative(path.join(HERE, ".."), file)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

main()
  .catch((e) => {
    console.error("ERR", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { ws?.close(); } catch {}
    if (chromeProc) { try { process.kill(-chromeProc.pid); } catch {} }
  });

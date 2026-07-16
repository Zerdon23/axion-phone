'use strict'
// Drives the real PWA in a real browser against the real Turso database, and
// looks at what comes out. Zero dependencies: static server + Chrome DevTools
// Protocol over Node's built-in WebSocket.
//
//   node tools/drive.js            screenshot the PC tab
//   node tools/drive.js --launch   also tap "Open" on an app and verify it opened
//
// Why bother: every layer here (service worker cache, Turso CORS, the phone's
// own SQL) can fail in a way that unit tests never see.

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PORT = 8931
const CDP_PORT = 9333
const OUT = path.join(__dirname, 'shot')
const CLOUD = path.join(process.env.APPDATA, 'Axion', 'cloud.json')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
}

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = req.url.split('?')[0].split('#')[0]
      if (p === '/') p = '/index.html'
      const file = path.join(ROOT, p)
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end() }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' })
        res.end(data)
      })
    })
    srv.listen(PORT, () => resolve(srv))
  })
}

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* browser still starting */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('browser never exposed a debug target')
}

/** Minimal CDP client. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    }
    ws.onerror = () => reject(new Error('ws error'))
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const mid = ++id
            pending.set(mid, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
          }),
        close: () => ws.close(),
      })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const wantLaunch = process.argv.includes('--launch')
  const cfg = JSON.parse(fs.readFileSync(CLOUD, 'utf8'))
  fs.mkdirSync(OUT, { recursive: true })

  const srv = await serve()
  console.log(`serving ${ROOT} on :${PORT}`)

  const profile = path.join(os.tmpdir(), 'axion-phone-drive')
  fs.rmSync(profile, { recursive: true, force: true })
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=430,932',            // iPhone-ish
    'about:blank',
  ], { windowsHide: true })

  const target = await cdpTargets()
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // Phone viewport, so the layout under test is the layout he'll see.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
  })

  const errors = []
  await cdp.send('Log.enable').catch(() => {})
  await cdp.send('Runtime.consoleAPICalled').catch(() => {})

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js threw')
    return r.result.value
  }

  // Creds via the hash, exactly how his QR setup link works.
  const url = `http://127.0.0.1:${PORT}/index.html#url=${encodeURIComponent(cfg.url)}&token=${encodeURIComponent(cfg.token)}`
  await cdp.send('Page.navigate', { url })
  await sleep(2500)

  // Straight to the PC tab.
  await evalJs(`(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.dataset.t==='pc'); if(t) t.click(); return !!t })()`)
  await sleep(3500)

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const f = path.join(OUT, name)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    console.log('  shot ->', f)
  }

  const dump = async () => ({
    status: await evalJs(`document.getElementById('pcstatus')?.innerText.trim()`),
    open: await evalJs(`[...document.querySelectorAll('#pcopen .app .title')].map(e=>e.innerText.trim())`),
    launch: await evalJs(`[...document.querySelectorAll('#pclaunch .app .title')].map(e=>e.innerText.trim())`),
    note: await evalJs(`document.getElementById('pcnote')?.innerText.trim()`),
  })

  console.log('\n--- PC tab as rendered in the browser ---')
  let d = await dump()
  console.log('status     :', d.status)
  console.log('open apps  :', d.open.length, '->', d.open.join(', '))
  console.log('launch list:', d.launch.length, '->', d.launch.slice(0, 6).join(', '), '…')
  await shot('pc-tab.png')

  if (wantLaunch) {
    console.log('\n--- searching "sticky", then tapping Open ---')
    // The launch list is capped at 10 until you search, same as on the phone.
    await evalJs(`(() => {
      const q=document.getElementById('pcq');
      q.value='sticky'; q.dispatchEvent(new Event('input'));
    })()`)
    await sleep(400)
    console.log('   filtered to:', await evalJs(`[...document.querySelectorAll('#pclaunch .app .title')].map(e=>e.innerText.trim())`))
    const tapped = await evalJs(`(() => {
      const rows=[...document.querySelectorAll('#pclaunch .app')];
      const row=rows.find(r=>/sticky notes/i.test(r.innerText));
      if(!row) return 'not found';
      row.querySelector('[data-launch]').click(); return 'tapped';
    })()`)
    console.log('  ', tapped)
    for (let i = 0; i < 20; i++) {
      await sleep(1000)
      const n = await evalJs(`document.getElementById('pcnote')?.innerText.trim()`)
      if (n && !/…$/.test(n)) { console.log('   note:', n); break }
    }
    await sleep(2000)
    d = await dump()
    console.log('   open apps now:', d.open.join(', '))
    await shot('pc-after-launch.png')
  }

  cdp.close()
  edge.kill()
  srv.close()
  console.log('\ndone')
  process.exit(0)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })

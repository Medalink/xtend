import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(here, '..', 'docs')
const require = createRequire(path.join(here, '..', 'tools', 'package.json'))
const { chromium } = require('playwright')
const MIN = 60_000

const ORIGIN = 'http://xtend.test/'
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const url = (rel) => ORIGIN + rel
fs.mkdirSync(path.join(DOCS, 'img'), { recursive: true })

const browser = await chromium.launch()
const serve = (page) => page.route(`${ORIGIN}**`, (route) => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(1)) || 'index.html'
  const file = path.join(DOCS, rel)
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' })
  route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) })
})
const errors = []

async function app(id, play) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.on('pageerror', (e) => errors.push(`${id}: ${e.message}`))
  await serve(page)
  await page.clock.install()
  await page.goto(url(`states/${id}/index.html`))
  await play(page)
  await page.screenshot({ path: path.join(DOCS, 'img', `${id}.png`) })
  await page.close()
}

const start = (page) => page.keyboard.press('Space').catch(() => {})
const click = (page, sel) => page.click(sel)
const run = (page, minutes) => page.clock.runFor(minutes * MIN)

await app('1-upstream', async (p) => { await click(p, '#start'); await run(p, 7) })
await app('2-yours', async (p) => { await p.mouse.click(5, 5); await start(p); await run(p, 18); await start(p); await p.waitForTimeout(1000) })
await app('3-upstream-v2', async (p) => {
  for (let i = 0; i < 2; i++) { await click(p, '#start'); await run(p, 25.1); await click(p, '#start'); await run(p, 5.1) }
  await click(p, '#start'); await run(p, 9)
})
await app('4-synced', async (p) => {
  await p.mouse.click(5, 5)
  for (let i = 0; i < 3; i++) { await start(p); await run(p, 50.1); await start(p); await run(p, 10.1) }
  await start(p); await run(p, 18); await start(p); await p.waitForTimeout(1000)
})

async function board(name, { width = 1440, height = 900, selector, full = false, theme = 'ink' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => errors.push(`board: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`board console: ${m.text()}`))
  await serve(page)
  await page.addInitScript((t) => localStorage.setItem('sd-theme', t), theme)
  await page.goto(url('index.html'))
  await page.waitForLoadState('networkidle')
  if (selector) await page.addStyleTag({ content: '.x-top { position: static } .sd-skip { display: none }' })
  const target = selector ? page.locator(selector) : page
  await target.screenshot({ path: path.join(DOCS, 'img', `${name}.png`), fullPage: full })
  await page.close()
}

await board('og', { width: 1200, height: 630 })
await board('board-hero', { selector: '.x-hero' })
await board('board-hard-case', { selector: '#hard' })
await board('board-screens', { selector: '#states' })
await board('board-how', { selector: '#how' })
await board('board-owners', { selector: '#owners' })
await board('board-log', { selector: '#log' })
await board('board-full', { full: true })
await board('board-paper', { width: 1440, height: 900, theme: 'paper' })

for (const width of [375, 768, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  await serve(page)
  await page.goto(url('index.html'))
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  if (over > 0) errors.push(`board overflows by ${over}px at ${width}px`)
  if (width === 375) await page.screenshot({ path: path.join(DOCS, 'img', 'board-phone.png') })
  await page.close()
}

await browser.close()
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('shots ok')

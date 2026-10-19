/**
 * Self-contained regression test for the host-half /video route.
 *
 * No ffmpeg or external fixtures required: it fabricates a byte file in a temp
 * dir, mounts the host half against a real node http server, and asserts the
 * Range/security semantics (200 full, 206 ranges, suffix range, 416, absolute
 * path outside the cwd, relative resolution, missing 404, cross-site 403, HEAD,
 * POST 405).
 *
 *   node test/route.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = require('../index.js')

// --- fixture: a deterministic byte blob standing in for a video file --------
const root = mkdtempSync(join(tmpdir(), 'dsh-video-preview-'))
const file = join(root, 'clip.mp4')
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256))
writeFileSync(file, bytes)
const size = bytes.length

let handler = null
const fakeCtx = {
  sessions: { get: (id) => (id === 'sess-1' ? { header: { cwd: root } } : undefined) },
  webStartup: { trustedHosts: [] },
  webServer: { register: (entry) => { handler = entry.handler; return () => {} } },
  effect: (fn) => { fn(); return () => {} },
}
await mod.apply(fakeCtx)

const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const url = (p) => `${base}/video?sessionId=sess-1&path=${encodeURIComponent(file)}`

let pass = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { console.log(`  ✗ FAIL ${name}${extra ? ' — ' + extra : ''}`); process.exitCode = 1 }
}
const req = (path, opts = {}) => fetch(path, opts).then(async (res) => ({ status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) }))

const r1 = await req(url())
check('GET 200', r1.status === 200)
check('content-type video/mp4', r1.headers.get('content-type') === 'video/mp4')
check('accept-ranges bytes', r1.headers.get('accept-ranges') === 'bytes')
check('full body equals file', r1.buf.equals(bytes))

const r2 = await req(url(), { headers: { range: 'bytes=0-99' } })
check('range 206', r2.status === 206)
check('content-range', r2.headers.get('content-range') === `bytes 0-99/${size}`)
check('slice 0..99', r2.buf.equals(bytes.subarray(0, 100)))

const r3 = await req(url(), { headers: { range: 'bytes=100-' } })
check('open-ended range 206', r3.status === 206)
check('slice 100..end', r3.buf.equals(bytes.subarray(100)))

const r4 = await req(url(), { headers: { range: 'bytes=-50' } })
check('suffix range 206', r4.status === 206)
check('suffix slice', r4.buf.equals(bytes.subarray(size - 50)))

const r5 = await req(url(), { headers: { range: 'bytes=999999-' } })
check('unsatisfiable 416', r5.status === 416)
check('416 content-range */', r5.headers.get('content-range') === `bytes */${size}`)

// No workspace containment (same as better-sidebar's fs routes): an absolute
// path outside the session cwd streams — this is the /tmp scratch-dir case.
const outside = mkdtempSync(join(tmpdir(), 'dsh-video-preview-outside-'))
const outsideFile = join(outside, 'clip.mp4')
const outsideBytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 17 + 5) % 256))
writeFileSync(outsideFile, outsideBytes)

const r6 = await req(`${base}/video?sessionId=sess-1&path=${encodeURIComponent(outsideFile)}`)
check('absolute path outside cwd 200', r6.status === 200)
check('outside body equals file', r6.buf.equals(outsideBytes))

const r7 = await req(`${base}/video?sessionId=sess-1&path=${encodeURIComponent('clip.mp4')}`)
check('relative path resolves against cwd 200', r7.status === 200)
check('relative body equals file', r7.buf.equals(bytes))

const r7b = await req(`${base}/video?sessionId=sess-1&path=${encodeURIComponent(`../${basename(outside)}/clip.mp4`)}`)
check('relative path may leave cwd (no containment) 200', r7b.status === 200)
check('escaped relative body equals file', r7b.buf.equals(outsideBytes))

const r7c = await req(`${base}/video?sessionId=sess-1&path=${encodeURIComponent(join(root, 'missing.mp4'))}`)
check('missing file 404', r7c.status === 404)

// A leading `~` names the host user's home, never a cwd-relative segment: the
// client shim expands it before better-sidebar's fs routes, and this route
// expands it on its own so both halves agree on the semantics.
const homeRes = await req(`${base}/video/home`)
const homeBody = JSON.parse(homeRes.buf.toString())
check('/video/home 200', homeRes.status === 200)
check('/video/home matches os.homedir()', homeBody.home === homedir())

const homeFixture = mkdtempSync(join(homedir(), '.dsh-video-preview-test-'))
const homeFile = join(homeFixture, 'clip.mp4')
writeFileSync(homeFile, bytes)
const tildePath = `~/${basename(homeFixture)}/clip.mp4`
const rTilde = await req(`${base}/video?sessionId=sess-1&path=${encodeURIComponent(tildePath)}`)
check('tilde path 200', rTilde.status === 200, tildePath)
check('tilde body equals file', rTilde.buf.equals(bytes))
const rTildeMissing = await req(`${base}/video?sessionId=sess-1&path=${encodeURIComponent('~/.dsh-video-preview-test-missing/clip.mp4')}`)
check('tilde path missing 404', rTildeMissing.status === 404)
rmSync(homeFixture, { recursive: true, force: true })

const r8 = await req(url(), { headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } })
check('cross-site 403', r8.status === 403)

const r9 = await req(url(), { method: 'HEAD' })
check('HEAD 200', r9.status === 200)
check('HEAD empty body', r9.buf.length === 0)

const r10 = await req(url(), { method: 'POST' })
check('POST 405', r10.status === 405)

server.close()
console.log(`\n${pass} route checks passed (fixture dir ${root})`)

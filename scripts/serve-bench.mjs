/**
 * Serves the extension test bench — `npm run ext:bench`.
 *
 * A content script cannot run on a `file://` page, so the bench needs an
 * origin. Twenty lines of `node:http` rather than a dependency, bound to
 * loopback so nothing outside this machine can reach it.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = join(root, 'extension', 'test-page.html')
const PORT = 4180

const server = createServer(async (request, response) => {
  try {
    const html = await readFile(page, 'utf8')
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(html)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(`Could not read extension/test-page.html\n${error}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Test bench: http://localhost:${PORT}`)
  console.log('  Load extension/dist as an unpacked extension, then open that URL.')
  console.log('  Ctrl-C to stop.\n')
})

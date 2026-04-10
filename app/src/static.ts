/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Flow</title>
  <link rel="stylesheet" href="/index.css">
  <style>html, body { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js"></script>
</body>
</html>`

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url || '/'
  const pathname = url.split('?')[0]

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML_SHELL)
    return
  }

  // Only serve known asset files from the webview directory
  const basename = path.basename(pathname)
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const filePath = path.join(WEBVIEW_DIR, basename)

  // Prevent path traversal
  if (!filePath.startsWith(WEBVIEW_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': mime })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

#!/usr/bin/env node
/**
 * Builds the standalone web app package:
 *   1. Builds the webview UI via Vite (into app/dist/webview/)
 *   2. Bundles the app entry via esbuild (into app/dist/app.js)
 */
'use strict'

const { execSync } = require('child_process')
const esbuild = require('esbuild')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const APP_DIR = __dirname
const APP_PKG = require(path.join(APP_DIR, 'package.json'))

console.log('Building Agent Flow app...\n')

// 1. Build the webview UI
console.log('[1/2] Building webview...')
execSync('npx vite build --config vite.config.app.ts', {
  cwd: path.join(ROOT, 'web'),
  stdio: 'inherit',
})

// 2. Bundle the app
console.log('\n[2/2] Bundling app...')
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'src', 'app.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(APP_DIR, 'dist', 'app.js'),
  alias: {
    'vscode': path.join(ROOT, 'scripts', 'vscode-shim.js'),
  },
  define: {
    AGENT_FLOW_APP_VERSION: JSON.stringify(APP_PKG.version),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  sourcemap: false,
  logLevel: 'warning',
})

console.log('\nDone! Package ready in app/dist/')

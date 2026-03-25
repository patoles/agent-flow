#!/usr/bin/env node
/**
 * Builds the dev relay by bundling scripts/dev-relay.ts with extension source.
 * Aliases the `vscode` module to a minimal shim so extension code runs outside VS Code.
 */
'use strict'

const esbuild = require('esbuild')
const path = require('path')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'dev-relay.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(__dirname, '.dev-relay.js'),
  alias: {
    'vscode': path.join(__dirname, 'vscode-shim.js'),
  },
  sourcemap: true,
  logLevel: 'warning',
})

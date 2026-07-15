#!/usr/bin/env node
/* ============================================================
   server.js — LOCAL DEV server: static files + /api/* dispatch.
   Zero dependencies (Node 18+). All fetchers/caching live in
   lib/api-core.js (shared with the Vercel function api/[...path].js);
   this file only exists so `node server.js` works offline-style
   on localhost:4173 exactly like production.
   ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleApi, routes, sendJSON } = require('./lib/api-core');
const { handleAgent } = require('./lib/agent-core');
const { handleAgentLog } = require('./lib/agent-log-view');

const PORT = Number(process.env.PORT) || 4173;
const STATIC_ROOT = path.join(__dirname, 'public'); // mirrors Vercel's outputDirectory

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/api/agent') return await handleAgent(req, res); // mirrors api/agent.js (real file beats the Vercel rewrite)
    if (p === '/api/agent-log') return await handleAgentLog(req, res); // mirrors api/agent-log.js
    if (p.startsWith('/api/')) return await handleApi(p, res);
    // static: index.html for /, real files otherwise (no path escape, no dotfiles)
    let file = p === '/' ? 'index.html' : p.slice(1);
    file = path.normalize(file);
    if (file.startsWith('..') || path.isAbsolute(file) || file.startsWith('.')) {
      res.writeHead(404); return res.end('not found');
    }
    const full = path.join(STATIC_ROOT, file);
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(new Date().toISOString(), 'request error:', e.message || e);
    sendJSON(res, { error: 'internal' }, 500);
  }
}).listen(PORT, () => console.log('manhattan-island backend on http://localhost:' + PORT +
  '  (routes: ' + [...routes.keys()].join(', ') + ', /api/route/:callsign)'));

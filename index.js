const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const TOKEN = process.env.GATEWAY_TOKEN || '';
const PORT = process.env.PORT || 3000;
const MAX_BODY = 2 * 1024 * 1024;

function authed(req) {
  return TOKEN.length > 0 && req.headers['x-gateway-token'] === TOKEN;
}

function sendJson(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- VLESS over WebSocket via a local Xray child process ----------
// UUID and WS path are derived deterministically from GATEWAY_TOKEN, so they
// stay stable across restarts/redeploys without extra env vars, and are never
// stored in the repo.
function deriveUuid() {
  const h = crypto.createHmac('sha256', TOKEN).update('vless-uuid-v1').digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = b.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
function deriveWsPath() {
  const h = crypto.createHmac('sha256', TOKEN).update('vless-ws-path-v1').digest('hex');
  return '/' + h.slice(0, 16);
}

const VLESS_UUID = TOKEN ? deriveUuid() : '';
const WS_PATH = TOKEN ? deriveWsPath() : '/never-match';
const XRAY_PORT = 8080;
const XRAY_DIR = '/tmp/xray-vless';
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const XRAY_CFG = path.join(XRAY_DIR, 'config.json');
const XRAY_URL = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';

let xrayChild = null;
let xrayReady = false;
let xrayBusy = false;

function writeXrayConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1',
      port: XRAY_PORT,
      protocol: 'vless',
      settings: { clients: [{ id: VLESS_UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: WS_PATH } },
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
  fs.writeFileSync(XRAY_CFG, JSON.stringify(cfg));
}

function probeXray() {
  const t0 = Date.now();
  const attempt = () => {
    const s = net.connect(XRAY_PORT, '127.0.0.1');
    s.on('connect', () => { xrayReady = true; s.end(); console.log('xray ready on ' + XRAY_PORT); });
    s.on('error', () => { if (Date.now() - t0 < 30000) setTimeout(attempt, 1000); });
  };
  setTimeout(attempt, 500);
}

function startXray() {
  writeXrayConfig();
  xrayChild = spawn(XRAY_BIN, ['run', '-config', XRAY_CFG], { stdio: ['ignore', 'pipe', 'pipe'] });
  xrayChild.stdout.on('data', (d) => process.stdout.write('[xray] ' + d));
  xrayChild.stderr.on('data', (d) => process.stderr.write('[xray] ' + d));
  xrayChild.on('exit', (code) => {
    console.log('xray exited code=' + code + ', restarting in 5s');
    xrayChild = null;
    xrayReady = false;
    setTimeout(ensureXray, 5000);
  });
  probeXray();
}

function ensureXray() {
  if (!TOKEN || xrayBusy || xrayChild) return;
  if (fs.existsSync(XRAY_BIN)) { startXray(); return; }
  xrayBusy = true;
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  console.log('downloading xray...');
  exec(
    'cd ' + XRAY_DIR + ' && curl -sL -m 120 -o x.zip ' + XRAY_URL + ' && unzip -o -q x.zip xray && chmod +x xray && rm -f x.zip',
    { timeout: 150000 },
    (err) => {
      xrayBusy = false;
      if (err) {
        console.error('xray download failed: ' + err.message + ', retry in 30s');
        setTimeout(ensureXray, 30000);
        return;
      }
      console.log('xray downloaded');
      startXray();
    }
  );
}

// ---------- Gateway HTTP server (v1 behavior preserved) ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    return res.end('unauthorized');
  }

  if (url.pathname === '/vless-info') {
    return sendJson(res, { uuid: VLESS_UUID, wsPath: WS_PATH, xrayReady, xrayRunning: !!xrayChild });
  }

  if (url.pathname === '/run' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      let cmd = null;
      let timeout = 20000;
      try {
        const j = JSON.parse(body || '{}');
        cmd = j.cmd;
        if (j.timeout) timeout = Math.min(Number(j.timeout) || 20000, 120000);
      } catch (e) { /* ignore */ }
      if (!cmd) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('missing cmd');
      }
      exec(cmd, { timeout, maxBuffer: MAX_BODY, shell: '/bin/sh' }, (err, stdout, stderr) => {
        sendJson(res, {
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          killed: !!(err && err.killed),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
    });
    return;
  }

  if (url.pathname === '/fetch') {
    const target = url.searchParams.get('url');
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('missing url');
    }
    try {
      const r = await fetch(target, {
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 gateway' },
        redirect: 'follow',
      });
      const buf = Buffer.from(await r.arrayBuffer());
      sendJson(res, {
        status: r.status,
        finalUrl: r.url,
        contentType: r.headers.get('content-type'),
        body: buf.subarray(0, MAX_BODY).toString('utf8'),
      });
    } catch (e) {
      sendJson(res, { error: String(e) });
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// WebSocket upgrades on the secret path are piped raw to the local Xray.
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* ignore */ }
  if (pathname !== WS_PATH || !xrayReady) { socket.destroy(); return; }
  const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
    let raw = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => console.log('gateway listening on ' + PORT));
ensureXray();

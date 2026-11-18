const http = require('http');
const { exec } = require('child_process');

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

server.listen(PORT, () => console.log('gateway listening on ' + PORT));

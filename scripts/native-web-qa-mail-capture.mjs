import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSmtpServer } from 'node:net';
import { pathToFileURL } from 'node:url';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function splitHeadersAndBody(value) {
  const match = /\r?\n\r?\n/.exec(value);
  if (!match) return { headers: '', body: value };
  return {
    headers: value.slice(0, match.index),
    body: value.slice(match.index + match[0].length),
  };
}

function decodeTransferBody(body, encoding) {
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') {
    const binary = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    return Buffer.from(binary, 'binary').toString('utf8');
  }
  return body;
}

function decodeMimeMessage(raw) {
  const root = splitHeadersAndBody(raw);
  const boundary = root.headers.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  const parts = boundary ? root.body.split(`--${boundary}`) : [raw];
  const decoded = { text: '', html: '' };
  for (const value of parts) {
    const part = splitHeadersAndBody(value.replace(/^\r?\n|\r?\n$/g, ''));
    const type = part.headers.match(/^Content-Type:\s*([^;\r\n]+)/mi)?.[1]?.toLowerCase();
    if (type !== 'text/plain' && type !== 'text/html') continue;
    const encoding = part.headers.match(/^Content-Transfer-Encoding:\s*([^\s]+)/mi)?.[1]?.toLowerCase();
    const body = decodeTransferBody(part.body.replace(/\r?\n--$/, ''), encoding).trim();
    if (type === 'text/plain') decoded.text += body;
    else decoded.html += body;
  }
  if (!decoded.text && !decoded.html && !boundary) decoded.text = root.body.trim() || raw;
  return decoded;
}

export async function createMailCapture({ host = '127.0.0.1', httpPort, smtpPort }) {
  const messages = [];
  const smtp = createSmtpServer((socket) => {
    let buffer = '';
    let dataMode = false;
    let dataLines = [];
    let recipient = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.write('220 native-web-qa ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n');
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        if (dataMode) {
          if (line === '.') {
            const raw = dataLines.join('\r\n');
            const id = randomUUID();
            const subject = raw.match(/^Subject:\s*(.+)$/mi)?.[1] ?? '';
            const decoded = decodeMimeMessage(raw);
            messages.unshift({ id, recipient, subject, raw, ...decoded, createdAt: new Date().toISOString() });
            dataMode = false;
            dataLines = [];
            socket.write('250 2.0.0 queued\r\n');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-native-web-qa\r\n250 SIZE 10485760\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 sender ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          recipient = line.match(/<([^>]+)>/)?.[1] ?? line.slice(8).trim();
          socket.write('250 2.1.5 recipient ok\r\n');
        } else if (upper === 'DATA') {
          dataMode = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (upper === 'RSET') {
          recipient = '';
          dataLines = [];
          dataMode = false;
          socket.write('250 2.0.0 reset\r\n');
        } else if (upper === 'QUIT') {
          socket.end('221 2.0.0 bye\r\n');
        } else if (line) {
          socket.write('250 2.0.0 ok\r\n');
        }
      }
    });
  });

  const http = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/api/v1/messages') {
      response.end(JSON.stringify({
        messages: messages.map((message) => ({
          ID: message.id,
          Subject: message.subject,
          To: [{ Address: message.recipient }],
          Created: message.createdAt,
        })),
      }));
      return;
    }
    const detailId = url.pathname.match(/^\/api\/v1\/message\/([^/]+)$/)?.[1];
    if (request.method === 'GET' && detailId) {
      const message = messages.find((item) => item.id === decodeURIComponent(detailId));
      if (!message) {
        response.writeHead(404);
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      response.end(JSON.stringify({
        ID: message.id,
        Text: message.text || message.raw,
        HTML: message.html,
        To: [{ Address: message.recipient }],
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ ok: false }));
  });

  const [actualHttpPort, actualSmtpPort] = await Promise.all([
    listen(http, httpPort, host),
    listen(smtp, smtpPort, host),
  ]);
  return {
    httpPort: actualHttpPort,
    smtpPort: actualSmtpPort,
    async close() { await Promise.all([close(http), close(smtp)]); },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const capture = await createMailCapture({
    host: '127.0.0.1',
    httpPort: Number(process.env.MAIL_CAPTURE_HTTP_PORT),
    smtpPort: Number(process.env.MAIL_CAPTURE_SMTP_PORT),
  });
  console.log(`native-web-qa mail capture http=${capture.httpPort} smtp=${capture.smtpPort}`);
  const shutdown = async () => { await capture.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

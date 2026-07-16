import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';

const configPath = process.argv[2];
if (!configPath) throw new Error('TLS proxy config path is required');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const server = createServer({
  key: readFileSync(config.keyPath),
  cert: readFileSync(config.certificatePath),
}, (request, response) => {
  if (request.url === '/__qa_proxy_health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'native-web-qa-tls-proxy' }));
    return;
  }
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: config.targetPort,
    method: request.method,
    path: request.url,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  });
  request.pipe(upstream);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`native-web-qa TLS proxy listening on https://127.0.0.1:${config.port}`);
});

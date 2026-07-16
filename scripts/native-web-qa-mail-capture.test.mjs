import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createMailCapture } from './native-web-qa-mail-capture.mjs';

test('captures a real SMTP DATA transaction through the HTTP message API', async () => {
  const capture = await createMailCapture({ host: '127.0.0.1', httpPort: 0, smtpPort: 0 });
  try {
    const socket = createConnection({ host: '127.0.0.1', port: capture.smtpPort });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write('EHLO qa.test\r\nMAIL FROM:<sender@example.test>\r\nRCPT TO:<user@example.test>\r\nDATA\r\n');
    socket.write('Subject: verify\r\nTo: user@example.test\r\n\r\n验证码 123456\r\n.\r\nQUIT\r\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.destroy();

    const listing = await (await fetch(`http://127.0.0.1:${capture.httpPort}/api/v1/messages`)).json();
    assert.equal(listing.messages.length, 1);
    assert.match(JSON.stringify(listing.messages[0]), /user@example\.test/);
    const detail = await (await fetch(`http://127.0.0.1:${capture.httpPort}/api/v1/message/${listing.messages[0].ID}`)).json();
    assert.match(detail.Text, /123456/);
  } finally {
    await capture.close();
  }
});

test('keeps the capture service alive when an SMTP client resets its connection', async () => {
  const capture = await createMailCapture({ host: '127.0.0.1', httpPort: 0, smtpPort: 0 });
  try {
    const socket = createConnection({ host: '127.0.0.1', port: capture.smtpPort });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write('EHLO qa.test\r\n');
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`http://127.0.0.1:${capture.httpPort}/api/v1/messages`);
    assert.equal(response.status, 200);
  } finally {
    await capture.close();
  }
});

test('decodes a multipart base64 verification message like the Mailpit API', async () => {
  const capture = await createMailCapture({ host: '127.0.0.1', httpPort: 0, smtpPort: 0 });
  try {
    const socket = createConnection({ host: '127.0.0.1', port: capture.smtpPort });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const encoded = Buffer.from('你的验证码是 654321。', 'utf8').toString('base64');
    socket.write('EHLO qa.test\r\nMAIL FROM:<sender@example.test>\r\nRCPT TO:<user@example.test>\r\nDATA\r\n');
    socket.write([
      'Subject: verify',
      'Content-Type: multipart/alternative; boundary="qa-boundary"',
      '',
      '--qa-boundary',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
      '--qa-boundary--',
      '.',
      'QUIT',
      '',
    ].join('\r\n'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.destroy();

    const listing = await (await fetch(`http://127.0.0.1:${capture.httpPort}/api/v1/messages`)).json();
    const detail = await (await fetch(`http://127.0.0.1:${capture.httpPort}/api/v1/message/${listing.messages[0].ID}`)).json();
    assert.match(detail.Text, /验证码是 654321/);
  } finally {
    await capture.close();
  }
});

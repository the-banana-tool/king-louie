// tests/helpers/fake-smtp.js
// A plain-text SMTP server over net on port 0 (no TLS, no auth) that keeps
// every message it accepts. Enough for nodemailer's send path.
const net = require('net');

async function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = [];
    let envelope = { from: null, to: [] };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 smtp.example.com ESMTP fake');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...envelope, raw: data.join('\r\n') });
            data = [];
            envelope = { from: null, to: [] };
            reply('250 2.0.0 queued');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') reply('250 smtp.example.com');
        else if (cmd === 'MAIL') { envelope.from = line.replace(/^MAIL FROM:\s*/i, ''); reply('250 2.1.0 ok'); }
        else if (cmd === 'RCPT') { envelope.to.push(line.replace(/^RCPT TO:\s*/i, '')); reply('250 2.1.5 ok'); }
        else if (cmd === 'DATA') { inData = true; reply('354 end with .'); }
        else if (cmd === 'RSET' || cmd === 'NOOP') reply('250 ok');
        else if (cmd === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('502 not implemented');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, messages, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { startFakeSmtp };

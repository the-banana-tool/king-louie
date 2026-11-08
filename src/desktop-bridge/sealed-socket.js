// A WebSocket as attachSealed's transport (R-RW-35). The dialer builds its socket
// with the seal's SOCKET_OPTIONS and hands it here.
const { EventEmitter } = require('events');

// `send` settles when ws's callback says the socket took the bytes: that is the
// backpressure. `data` carries isBinary, so attachSealed can refuse a text frame.
// `raw` is each chunk off the TCP stream, counted before ready, so a peer that has
// proved nothing is cut off while a message arrives and not after ws holds it.
// Only for an open socket: before that ws has no TCP stream to count (`_socket` is
// null), and a peer would be cut off only after ws had buffered a whole message.
function wsTransport(ws) {
  if (ws.readyState !== ws.OPEN) throw new Error('wsTransport needs an open socket');
  const transport = new EventEmitter();
  // ws parses in its own listener, so a message can come before its chunk's `raw`:
  // a transport with raw bytes says so, or the same bytes are counted twice.
  transport.countsRaw = true;
  const onRaw = (chunk) => transport.emit('raw', chunk);
  const socket = ws._socket;
  if (socket && typeof socket.on === 'function') socket.on('data', onRaw);
  ws.on('message', (data, isBinary) => transport.emit('data', data, isBinary));
  ws.on('close', (code) => {
    if (socket && typeof socket.removeListener === 'function') socket.removeListener('data', onRaw);
    transport.emit('close', code);
  });
  ws.on('error', () => {});
  transport.send = (bytes) => new Promise((resolve, reject) => {
    ws.send(bytes, { binary: true }, (err) => (err ? reject(err) : resolve()));
  });
  transport.close = (code, reason) => ws.close(code, reason);
  // Stops reading at once, for a peer being cut off mid-message.
  transport.terminate = () => {
    if (socket && typeof socket.pause === 'function') socket.pause();
    ws.terminate();
  };
  return transport;
}

module.exports = { wsTransport };

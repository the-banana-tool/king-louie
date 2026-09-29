// A stdio MCP server that frames messages the way the official SDK's
// StdioServerTransport does (mcp-remote and most published servers): one JSON
// message per line. A line that isn't JSON is dropped, as the SDK drops it, so
// a client that sends Content-Length headers never gets a reply.
// REPLY_FRAMING=content-length makes it reply with LSP-style headers instead.
const contentLengthReplies = process.env.REPLY_FRAMING === 'content-length';
let droppedLines = 0;
let buffered = '';

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(contentLengthReplies
    ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    : `${body}\n`);
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'line-stdio-server', version: '1.0.0' }
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{ name: 'dropped_lines', description: 'Lines that were not JSON', inputSchema: { type: 'object' } }]
    } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: String(droppedLines) }]
    } });
  }
}

process.stdin.on('data', (chunk) => {
  buffered += chunk.toString();
  let nl;
  while ((nl = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, nl).replace(/\r$/, '');
    buffered = buffered.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      droppedLines += 1;
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
// On Windows the client's kill reaches the shell, not this process; never outlive the test.
setTimeout(() => process.exit(0), 30000).unref();

const fs = require('fs');
const path = require('path');

module.exports = async function logToolUsage(context = {}) {
  const logPath = path.join(process.cwd(), 'hooks', 'tool-usage.log');
  const timestamp = new Date().toISOString();
  const toolName = context.toolName || 'unknown';
  const parameters = context.parameters || {};
  const result = context.result || {};
  const status = result.success === false ? 'error' : 'success';

  const line = JSON.stringify({
    timestamp,
    toolName,
    status,
    parameters,
    error: result.error || null
  });

  fs.appendFileSync(logPath, `${line}\n`, 'utf-8');
  return { action: 'allow' };
};

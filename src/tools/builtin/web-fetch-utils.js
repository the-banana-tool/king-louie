const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const TurndownService = require('turndown');

// SSRF protection: block private/reserved IP ranges
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
  /^::ffff:127\./,
  /^::ffff:10\./,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
  /^::ffff:192\.168\./
];

function isPrivateIp(ip) {
  const normalizedIp = ip.replace(/^\[/, '').replace(/\]$/, '');
  return PRIVATE_IP_RANGES.some(regex => regex.test(normalizedIp));
}

async function validateUrl(urlString, allowPrivateNetwork = false) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Blocked protocol: ${url.protocol}. Only HTTP(S) allowed.`);
  }
  if (!allowPrivateNetwork) {
    const cleanHostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

    // First check if hostname is localhost or a direct private IP
    if (cleanHostname === 'localhost' || isPrivateIp(cleanHostname)) {
      throw new Error(`Blocked: ${cleanHostname} is a private IP or localhost`);
    }

    // Resolve DNS and check IP to catch CNAMEs pointing to private IPs
    const { promises: dns } = require('dns');
    let addresses = [];

    try {
      addresses = await dns.lookup(cleanHostname, { all: true });
    } catch (err) {
      // Ignore lookup errors
    }

    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw new Error(`Blocked: ${url.hostname} resolves to private IP ${address}`);
      }
    }
  }
  return url;
}

function htmlToMarkdown(html) {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return turndown.turndown(html);
}

function htmlToText(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractReadableContent(html, url) {
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();
  return article ? { title: article.title, content: article.content } : null;
}

module.exports = { validateUrl, isPrivateIp, htmlToMarkdown, htmlToText, extractReadableContent };

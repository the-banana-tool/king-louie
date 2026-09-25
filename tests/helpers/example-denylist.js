// tests/helpers/example-denylist.js
// Finds values in docs and examples that look like they belong to a real
// person, machine or network. Everything in examples/ and the install guide
// is invented: example.com and its subdomains, the documentation IP ranges,
// +15550100 to +15550199, and <placeholder> path segments. Any stage that
// adds docs or examples runs its files through scanForPersonalValues.

const ALLOWED_HOSTS = Object.freeze([
  'example.com', 'localhost', '127.0.0.1', 'huggingface.co', 'nodejs.org', 'git-scm.com',
  'www.python.org', 'python.org', 'claude.ai', 'code.claude.com', 'docs.anthropic.com',
  'www.sudo.ws', 'learn.microsoft.com', 'github.com'
]);

// A bare dotted name is treated as a host only when it ends in one of these,
// so node.yaml, train.py or site.service are not mistaken for hosts.
const HOST_TLDS = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'ai', 'co', 'me', 'info', 'biz', 'xyz', 'cloud',
  'tech', 'us', 'uk', 'de', 'fr', 'ca', 'au', 'nl', 'eu', 'online', 'store', 'blog', 'page',
  'local', 'lan', 'internal', 'home', 'test'
]);

function hostAllowed(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return ALLOWED_HOSTS.includes(h) || h.endsWith('.example.com');
}

function ipAllowed([a, b, c, d]) {
  if (a === 127) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

const HOME_RULES = [
  { re: /\/home\/([^/\s<>'"`]+)\//g, allowed: () => false },
  { re: /\/Users\/([^/\s<>'"`]+)\//g, allowed: (name) => name === 'Shared' },
  { re: /[A-Za-z]:\\Users\\([^\\\s<>'"`]+)\\/g, allowed: (name) => ['public', 'default'].includes(name.toLowerCase()) },
  { re: /~([A-Za-z0-9._-]+)\//g, allowed: () => false }
];

function scanForPersonalValues(text) {
  const src = String(text);
  const findings = [];
  const add = (kind, value) => findings.push({ kind, value });

  for (const m of src.matchAll(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
    const [whole, local, domain] = m;
    const d = domain.toLowerCase();
    if (d === 'example.com' || d.endsWith('.example.com')) continue;
    if (local === 'git' && hostAllowed(d)) continue;
    add('email', whole);
  }

  for (const m of src.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g)) {
    const parts = m.slice(1, 5).map(Number);
    if (parts.some((n) => n > 255)) continue;
    if (!ipAllowed(parts)) add('ipv4', m[0]);
  }

  for (const { re, allowed } of HOME_RULES) {
    for (const m of src.matchAll(re)) {
      if (!allowed(m[1])) add('home-path', m[0]);
    }
  }

  for (const m of src.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"`<>]*@)?(\[[^\]\s]*\]|[^\s/:'"`<>)\]},;]+)/gi)) {
    if (!hostAllowed(m[1])) add('url-host', m[0]);
  }

  for (const m of src.matchAll(/(?<![A-Za-z0-9.@-])((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g)) {
    const [, host, tld] = m;
    if (!HOST_TLDS.has(tld.toLowerCase())) continue;
    if (!hostAllowed(host)) add('host', host);
  }

  for (const m of src.matchAll(/\+(\d{8,})/g)) {
    const n = Number(m[1]);
    if (!(m[1].length === 8 && n >= 15550100 && n <= 15550199)) add('phone', m[0]);
  }

  return findings;
}

module.exports = { ALLOWED_HOSTS, scanForPersonalValues };

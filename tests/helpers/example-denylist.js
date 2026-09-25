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

// A phone number is fictional (reserved for fiction, RFC-3092-style) when its
// last 7 digits are the 555 exchange with a line number from 0100 to 0199 —
// the same test the bare "+15550100" form already used, now applied to every
// digit string regardless of which separators produced it.
function isFictionalPhone(digits) {
  if (digits.length < 7) return false;
  const exchange = digits.slice(-7, -4);
  const line = Number(digits.slice(-4));
  return exchange === '555' && line >= 100 && line <= 199;
}

// No bare-digit rule: every pattern requires a separator (or a leading `+`)
// so dates, ports and version numbers are never mistaken for a phone number.
const PHONE_PATTERNS = [
  /\+\d{1,3}(?:[ -]\d{2,4}){2,4}/g, // +1 212 555 0199, +1-212-555-0199
  /\+\d{8,}/g, // +15550100 (bare digits after a leading +)
  /\(\d{3}\)\s?\d{3}-\d{4}/g, // (212) 555-0199
  /\b\d{3}-\d{3}-\d{4}\b/g, // 212-555-0199
  /\b\d{3}\.\d{3}\.\d{4}\b/g, // 212.555.0199
  /\b\d{3} \d{3} \d{4}\b/g // 212 555 0199
];

// A path name is a hit whether it is followed by the real separator or ends
// the reference: end of text, or a boundary character (whitespace, quote,
// backtick, `,` `.` `;` `:` or a closing bracket). A name that starts with
// `<` (an unresolved placeholder like <user>) never enters the capture, so
// placeholders stay allowed either way.
const HOME_RULES = [
  { re: /\/home\/([^/\s<>'"`]+)(?:\/|(?=[\s'"`,.;:)\]}]|$))/g, allowed: () => false },
  { re: /\/Users\/([^/\s<>'"`]+)(?:\/|(?=[\s'"`,.;:)\]}]|$))/g, allowed: (name) => name === 'Shared' },
  { re: /[A-Za-z]:\\Users\\([^\\\s<>'"`]+)(?:\\|(?=[\s'"`,.;:)\]}]|$))/g, allowed: (name) => ['public', 'default'].includes(name.toLowerCase()) },
  { re: /~([A-Za-z0-9._-]+)(?:\/|(?=[\s'"`,.;:)\]}]|$))/g, allowed: () => false }
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

  for (const re of PHONE_PATTERNS) {
    for (const m of src.matchAll(re)) {
      if (!isFictionalPhone(m[0].replace(/\D/g, ''))) add('phone', m[0]);
    }
  }

  return findings;
}

module.exports = { ALLOWED_HOSTS, scanForPersonalValues };

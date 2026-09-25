// RFC 8785 JSON Canonicalization Scheme. Every signed King Louie message is
// the JCS form of a JSON object, so this is the one place that decides which
// values can be signed at all.
const crypto = require('crypto');

class JcsError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'JcsError';
    this.code = code;
  }
}

// A high surrogate not followed by a low one, or a low one not preceded by a
// high one. Such a string has no UTF-8 encoding, so two implementations would
// sign different bytes for it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s) {
  if (LONE_SURROGATE.test(s)) throw new JcsError('non_canonical_value', 'lone surrogate');
  return JSON.stringify(s);
}

function serialize(value, ancestors) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non_canonical_value', 'non-finite number');
      // ECMAScript number serialization is exactly what RFC 8785 §3.2.2.3 specifies.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      // A container already on the current recursion path would recurse forever;
      // the same container reached twice via different paths (no cycle) is fine.
      if (ancestors.has(value)) throw new JcsError('non_canonical_value', 'circular reference');
      ancestors.add(value);
      try {
        // Array.from visits holes as undefined, which is refused below.
        if (Array.isArray(value)) return `[${Array.from(value, (v) => serialize(v, ancestors)).join(',')}]`;
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new JcsError('non_canonical_value', 'not a plain object');
        }
        // Default sort compares UTF-16 code units, which is the RFC 8785 order.
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${serializeString(k)}:${serialize(value[k], ancestors)}`).join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new JcsError('non_canonical_value', `unsupported type ${typeof value}`);
  }
}

function canonicalize(value) {
  return serialize(value, new Set());
}

// base64url (no padding) of SHA-256 over the UTF-8 bytes of a string, or over a Buffer.
function sha256b64url(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

module.exports = { canonicalize, sha256b64url, JcsError };

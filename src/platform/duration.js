// "90s", "5m", "2h", "30d" → milliseconds, or null for anything else. Used
// by node.yaml's frontdoor.oauth.* and delegate.idle_close.
const UNITS = Object.freeze({ s: 1000, m: 60000, h: 3600000, d: 86400000 });

function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,6})(s|m|h|d)$/.exec(text.trim());
  return m ? Number(m[1]) * UNITS[m[2]] : null;
}

module.exports = { parseDuration };

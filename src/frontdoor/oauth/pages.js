// The consent and message pages (fleet stage 4 §3.4): no script, no remote
// resources, one same-origin stylesheet; everything the client declared is
// escaped and marked as self-declared.
const { escapeHtml, printable } = require('../http-util');
const { formatUserCode } = require('../protocol/messages');

const CONSENT_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // For browsers that predate CSP frame-ancestors.
  'x-frame-options': 'DENY'
});

const CONSENT_CSS = `body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fafafa}
h1{font-size:1.3rem}.code{font:700 2.4rem ui-monospace,monospace;letter-spacing:.2rem;padding:.6rem 1rem;background:#fff;border:2px solid #333;display:inline-block}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem}dt{font-weight:600}.muted{color:#555}ul{padding-left:1.2rem}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}.code{background:#222;border-color:#ccc}.muted{color:#aaa}}
`;

// The host a URL points at, as the URL parser prints it (an IDN in its
// punycode form, so a look-alike host shows as the host it really is).
function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
}

// refresh is a same-origin path the server built; it is escaped for the
// attribute it sits in.
function page({ title, body, refresh = null }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `${refresh ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(refresh)}">` : ''}`
    + `<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/oauth/consent.css"></head><body>${body}</body></html>`;
}

// A name that is empty once its invisible characters are gone is shown as
// the client_id, so the page never shows a blank where the client should be.
function shownClientName(pending) {
  return printable(pending.client_name).trim() ? pending.client_name : pending.client_id;
}

function consentPage({ pending, scopeRegistry, waitUrl }) {
  const scopes = pending.requested_scopes.map((s) => {
    const def = scopeRegistry.get(s);
    return `<li><code>${escapeHtml(s)}</code>${def && def.description ? ` — ${escapeHtml(def.description)}` : ''}</li>`;
  }).join('');
  return page({
    title: 'Connect a client to King Louie',
    refresh: waitUrl,
    body: `<h1>Connect a client to King Louie</h1>`
      + `<dl><dt>Client</dt><dd>${escapeHtml(shownClientName(pending))} <span class="muted">(self-declared)</span></dd>`
      + `<dt>Client host</dt><dd>${escapeHtml(pending.client_host)}</dd>`
      + `<dt>Returns to</dt><dd>${escapeHtml(hostOf(pending.redirect_uri))}</dd></dl>`
      + `<p>It asks for:</p><ul>${scopes}</ul>`
      + `<p>Open King Louie on your phone → Connect a client → type this code:</p>`
      + `<p class="code" id="user-code">${escapeHtml(formatUserCode(pending.user_code))}</p>`
      + `<p class="muted">There is no password. This page moves on by itself once your phone decides.</p>`
  });
}

function messagePage({ title, message }) {
  return page({ title, body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` });
}

module.exports = { CONSENT_HEADERS, CONSENT_CSS, consentPage, messagePage };

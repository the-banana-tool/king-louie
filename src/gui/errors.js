// src/gui/errors.js
// Fleet stage 5 error codes (spec §9). A GuiError's code is what a GUI tool
// returns as { ok: false, error: '<code>[: detail]' }; the session helper
// sends the same codes over kl-session-v1 in res.error.code. Dependency-free:
// the runbook profile loads this file through src/gui/config.js.
const GUI_ERROR_CODES = Object.freeze([
  'capability_unavailable', 'invalid_params', 'app_not_allowlisted', 'app_type_not_supported', 'file_not_found',
  'path_changed', 'app_required', 'app_not_running', 'stale_screenshot', 'window_minimized', 'outside_window',
  'point_obscured', 'foreground_mismatch', 'user_active', 'screen_locked', 'target_elevated', 'invalid_text',
  'text_matches_always_confirm', 'text_looks_secret', 'key_invalid', 'key_denied', 'middle_click_denied',
  'rate_limited', 'lease_required', 'lease_suspended', 'lease_suspended_no_contact', 'lease_expired', 'lease_revoked', 'lease_busy',
  'lease_pending', 'lease_denied', 'lease_request_expired', 'job_required', 'job_closed', 'approval_unavailable', 'helper_disconnected',
  'helper_already_connected', 'frame_rejected', 'auth_failed', 'op_timeout', 'unknown_op', 'backend_failed',
  'session_not_installed', 'session_file_insecure', 'session_file_invalid', 'session_user_mismatch', 'unsafe_path', 'user_not_found',
  'home_missing', 'cancelled'
]);

// The ten GUI tools. Here (dependency-free) so code that shapes a run's tool
// list can name them without loading the tools themselves.
const GUI_TOOL_NAMES = Object.freeze(['ListApps', 'LaunchApp', 'CloseApp', 'Screenshot', 'RequestLease', 'Click', 'Type', 'Key', 'Scroll', 'Drag']);

class GuiError extends Error {
  constructor(code, detail = null, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GuiError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
    this.info = {};
    Object.assign(this, extra);
  }
}

function isGuiError(err) {
  return err instanceof GuiError || Boolean(err && err.name === 'GuiError' && typeof err.code === 'string');
}

// F3's refusal words for "no phone can sign" are kept exactly.
function toToolResult(err) {
  if (!isGuiError(err)) return { ok: false, error: `gui_error: ${err && err.message ? err.message : String(err)}` };
  if (err.code === 'approval_unavailable') return { ok: false, error: 'signed approval unavailable' };
  const out = { ok: false, error: err.message };
  if (err.retryAfter !== undefined) out.retry_after = err.retryAfter;
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A helper's res.error: { code, message, detail }. The helper is the user's
// process, so an unknown code never becomes one the service acts on.
function fromWire(error) {
  const code = isPlainObject(error) && GUI_ERROR_CODES.includes(error.code) ? error.code : 'backend_failed';
  return new GuiError(code, null, { info: isPlainObject(error) && isPlainObject(error.detail) ? error.detail : {} });
}

module.exports = { GuiError, GUI_ERROR_CODES, GUI_TOOL_NAMES, isGuiError, toToolResult, fromWire };

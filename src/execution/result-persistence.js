/**
 * Persist oversized tool results to disk so the conversation history
 * stays compact without losing data.
 *
 * Today AgentLoop._truncateToolContent strips fields with a regex
 * (`{ok, message, error, result}` only) and drops everything else —
 * `savedTo`, `html`, `page`, etc. A later iteration that needs the
 * dropped field has no recovery path.
 *
 * Replacement strategy (mirroring claude-code's toolResultStorage):
 *   - Small results (≤ threshold) pass through untouched.
 *   - Large results get written to userData/tool-results/<sessionId>/<uuid>.txt
 *     and the inline content becomes:
 *       [persisted: <path>] (N chars)
 *       <head 500 chars>
 *       …
 *   - The model still sees a useful preview AND knows where to look if
 *     it needs the full payload (Read tool can fetch it).
 *
 * The persistence directory is configurable. If no directory is provided
 * (e.g. in tests), persistence is a no-op and oversized results just get
 * head-truncated.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_THRESHOLD_CHARS = 50000;
const PREVIEW_HEAD_CHARS = 500;

class ResultPersistence {
  constructor(options = {}) {
    this.baseDir = options.baseDir || null;
    this.thresholdChars = Number.isFinite(options.thresholdChars)
      ? options.thresholdChars
      : DEFAULT_THRESHOLD_CHARS;
  }

  _resolveSessionDir(sessionId) {
    if (!this.baseDir) return null;
    const safeSession = sessionId
      ? String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
      : 'default';
    return path.join(this.baseDir, safeSession);
  }

  /**
   * Persist `content` if it exceeds the threshold. Returns either the
   * original string (small result, pass-through) or a preview string
   * with a `[persisted: <path>]` marker (large result).
   */
  persistIfLarge(content, { sessionId, toolName } = {}) {
    if (typeof content !== 'string') return content;
    if (content.length <= this.thresholdChars) return content;

    const sessionDir = this._resolveSessionDir(sessionId);
    if (!sessionDir) {
      // No persistence available — fall back to head truncation so we
      // don't blow out the context window.
      return this._headOnlyPreview(content, toolName);
    }

    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const filename = `${toolName || 'result'}-${id}.txt`;
      const fullPath = path.join(sessionDir, filename);
      fs.writeFileSync(fullPath, content, 'utf8');
      const head = content.slice(0, PREVIEW_HEAD_CHARS);
      return [
        `[persisted: ${fullPath}] (${content.length} chars; preview shows first ${PREVIEW_HEAD_CHARS})`,
        head,
        '…'
      ].join('\n');
    } catch (err) {
      console.warn(`[result-persistence] Failed to persist ${toolName} result: ${err.message}`);
      return this._headOnlyPreview(content, toolName);
    }
  }

  _headOnlyPreview(content, toolName) {
    const head = content.slice(0, PREVIEW_HEAD_CHARS);
    return [
      `[oversized ${toolName || 'result'}: ${content.length} chars, persistence unavailable; showing first ${PREVIEW_HEAD_CHARS}]`,
      head,
      '…'
    ].join('\n');
  }

  /**
   * Convenience: serialize a result object then persist if large. Used by
   * the agent loop after a tool call. Returns a possibly-modified copy
   * suitable for embedding in conversation history.
   */
  persistResultObject(result, ctx = {}) {
    if (result == null || typeof result !== 'object') return result;
    const serialized = JSON.stringify(result);
    if (serialized.length <= this.thresholdChars) return result;

    // Find the heaviest string field and persist that one specifically;
    // keeps the structural keys (success, error, etc.) intact so the model
    // can still see the shape.
    let heaviestKey = null;
    let heaviestLen = 0;
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && value.length > heaviestLen) {
        heaviestKey = key;
        heaviestLen = value.length;
      }
    }
    if (!heaviestKey || heaviestLen < this.thresholdChars / 2) {
      // No single dominant string — persist the whole serialized blob.
      return {
        ...result,
        _persistedNote: this.persistIfLarge(serialized, ctx),
        _persistedFullPayload: true
      };
    }
    return {
      ...result,
      [heaviestKey]: this.persistIfLarge(result[heaviestKey], { ...ctx, toolName: `${ctx.toolName || 'tool'}-${heaviestKey}` })
    };
  }
}

module.exports = ResultPersistence;

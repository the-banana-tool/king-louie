// OAuth 2.1 error codes the front door returns (fleet stage 4 §9).
const OAUTH_ERRORS = Object.freeze(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_scope', 'access_denied', 'invalid_redirect_uri', 'invalid_client_metadata', 'temporarily_unavailable']);

class OAuthError extends Error {
  constructor(error, description = error, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
  }
}

module.exports = { OAuthError, OAUTH_ERRORS };

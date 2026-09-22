// A prompter answers the agent loop's interactive questions (AskUser,
// directory access). Hosts inject one; with no interactive user, everything
// is denied.
const HEADLESS_ASK_USER_ERROR = 'No interactive user is available to answer questions (headless mode).';

function createHeadlessPrompter() {
  return {
    async askUser() {
      return { ok: false, error: HEADLESS_ASK_USER_ERROR };
    },
    async requestDirectoryAccess() {
      return false;
    }
  };
}

module.exports = { createHeadlessPrompter, HEADLESS_ASK_USER_ERROR };

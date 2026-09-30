'use strict';

// Browser actions that change something: they type into, click on or run code
// in a page, or fill a login or payment form, so they can send what the owner
// never saw. ToolExecutor asks for these even when the browser tool is on the
// "always approve" list or an agent's autoApproveTools. Two explicit
// instructions lift that: a permission rule for the action (`allow
// Browser(click)`), or an `ownerQuote` found in the owner's own message for
// this turn (ownerQuoteInTurn).

// ownerQuoteInTurn lives in src/tools/owner-quote.js, shared with the
// management tools' answer_question.
const { ownerQuoteInTurn } = require('./owner-quote');

const BROWSER_TOOLS = new Set(['Browser', 'BrowserPage', 'BrowserExtract', 'BrowserSession']);

const ACTING_ACTIONS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'clear',
  'select_option', 'check', 'uncheck', 'drag_and_drop', 'set_input_files',
  'evaluate', 'keyboard_type', 'keyboard_down', 'keyboard_up', 'mouse_click',
  'fill_in_frame', 'click_in_frame', 'type_in_frame', 'evaluate_in_frame',
  'fill_credentials', 'login', 'signup', 'fill_payment', 'handle_dialog'
]);

function isActingBrowserCall(toolName, params) {
  return BROWSER_TOOLS.has(toolName) && ACTING_ACTIONS.has(params?.action);
}

// The schema property every browser tool declares.
const OWNER_QUOTE_PARAM = {
  type: 'string',
  description: 'Only when the user, in their latest message, explicitly told you to do this action '
    + '(e.g. "go ahead and submit the form"): their exact words. Actions that type, click, run code or '
    + 'fill logins/payments otherwise wait for the user to approve them. Never quote words that are not '
    + 'about this action.'
};

module.exports = { BROWSER_TOOLS, ACTING_ACTIONS, OWNER_QUOTE_PARAM, isActingBrowserCall, ownerQuoteInTurn };

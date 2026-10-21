// src/cases/case-types/outreach.js
// Contacting people to get something (quotes, answers). No extras in stage 5;
// C4 and C6 add behaviour through contact policy and playbooks.
module.exports = {
  type: 'outreach',
  orientationExtras: () => '',
  gatingQuestions: () => [],
  materialFields: () => [],
  // Wake-ups may look in the browser (spec 2026-10-20-outreach-wakeup-browser, owner ruling
  // 2026-10-20): the case guard refuses typing and the wake-up's denyAutoApproval refuses a click.
  wakeupTools: () => ['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']
};

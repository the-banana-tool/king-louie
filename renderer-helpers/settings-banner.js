// The Settings banner (settings redesign spec §5.2, §8.2, §8.3): which machine's
// settings this window edits, from desktop:status, and whether the pages may be
// changed now. A plain script of the renderer's, and a module for its test: the
// renderer has no require. The text holds a node-supplied name: draw it with
// textContent only.

function settingsBannerNodeName(status) {
  const s = status || {};
  return (s.service && s.service.nodeName)
    || (s.node && s.node.name)
    || (s.pairing && s.pairing.service && s.pairing.service.name)
    || 'your node';
}

function settingsBanner(status) {
  const s = status || {};
  if (s.mode !== 'attached') {
    if (s.launch && s.launch.why === 'dev') return { tone: 'dev', text: 'Development standalone', readOnly: false };
    return { tone: 'desktop', text: 'Editing this desktop only, not your node', readOnly: false };
  }
  const name = settingsBannerNodeName(s);
  if (s.view === 'attached-connected') {
    const hosting = (s.service && s.service.hosting) || (s.pairing && s.pairing.service && s.pairing.service.hosting);
    return {
      tone: 'node',
      text: `Editing King Louie Node on ${name}${hosting === 'personal' ? ' (running as you)' : ''}`,
      readOnly: false
    };
  }
  if (s.view === 'attached-starting') return { tone: 'unreachable', text: `Starting ${name}…`, readOnly: true };
  return { tone: 'unreachable', text: `Can't reach ${name}: changes won't be saved until it's back`, readOnly: true };
}

// §8.3: the one case this window offers "Switch to my node" itself. Off Windows
// there is no personal node yet; under --kl-standalone (dev) there is no button.
function switchToNodeAction(status) {
  const s = status || {};
  return s.mode !== 'attached' && s.launch && s.launch.why === 'once' && s.platform === 'win32'
    ? 'leave-standalone'
    : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { settingsBanner, switchToNodeAction };
}

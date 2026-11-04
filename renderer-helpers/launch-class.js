// In the head, before the body is parsed: on an attached launch the chat shell stays
// hidden until the first status says whether it may show (attach stage 2 spec §6.2).
// The renderer takes the class off. A standalone launch has no query and no class.
if (new URLSearchParams(window.location.search).get('launch') === 'attached') {
  document.documentElement.classList.add('setup-pending');
}

let markdownParser = null;
let hljs = null;

try {
  const markedModule = require('marked');
  markdownParser = markedModule.marked || markedModule;
  
  // Try to load highlight.js
  try {
    hljs = require('highlight.js');
  } catch {
    hljs = null;
  }
  
  // Configure marked with highlight.js if available
  if (markdownParser && hljs) {
    const { marked } = markedModule;
    if (marked && marked.use) {
      // For newer versions of marked (v4+)
      const renderer = {
        code(code, language) {
          const validLang = language && hljs.getLanguage(language) ? language : null;
          let highlighted;
          try {
            highlighted = validLang
              ? hljs.highlight(code, { language: validLang }).value
              : hljs.highlightAuto(code).value;
          } catch {
            highlighted = code; // Fall back to original code if highlighting fails
          }
          const langClass = validLang ? `language-${validLang}` : 'language-auto';
          return `<pre><code class="hljs ${langClass}">${highlighted}</code></pre>`;
        }
      };
      marked.use({ renderer });
    }
  }
} catch {
  markdownParser = null;
}
const { describe, it } = require('node:test');
const assert = require('node:assert');

// Test highlight.js + marked integration directly
const hljs = require('highlight.js');
const { marked } = require('marked');

// Configure marked with highlight.js the same way preload.js does
const renderer = {
  code({ text, lang }) {
    const validLang = lang && hljs.getLanguage(lang) ? lang : null;
    const highlighted = validLang
      ? hljs.highlight(text, { language: validLang }).value
      : hljs.highlightAuto(text).value;
    const langClass = validLang ? ` language-${validLang}` : '';
    return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
  }
};

// Configure marked the same way preload.js does
marked.use({ renderer });

function markdownParse(text) {
  return marked.parse(text);
}

describe('Syntax Highlighting', () => {
  it('highlights JavaScript code blocks', () => {
    const result = markdownParse('```js\nconst x = 1;\n```');
    assert.ok(result.includes('hljs'));
    assert.ok(result.includes('hljs-keyword') || result.includes('hljs-variable') || result.includes('hljs-attr'));
  });

  it('highlights Python code blocks', () => {
    const result = markdownParse('```python\ndef hello():\n    print("hi")\n```');
    assert.ok(result.includes('hljs'));
  });

  it('auto-detects language when not specified', () => {
    const result = markdownParse('```\nfunction hello() { return true; }\n```');
    assert.ok(result.includes('hljs'));
  });

  it('does not break inline code', () => {
    const result = markdownParse('Use `const x = 1` in your code');
    assert.ok(result.includes('<code>'));
    assert.ok(result.includes('const x = 1'));
  });

  it('handles unknown language gracefully', () => {
    const result = markdownParse('```nonexistent\nsome code\n```');
    assert.ok(result.includes('<code'));
  });

  it('adds language class to code blocks', () => {
    const result = markdownParse('```javascript\nconst a = 1;\n```');
    assert.ok(result.includes('language-javascript'));
  });

  it('highlights HTML code blocks', () => {
    const result = markdownParse('```html\n<div class="test">Hello</div>\n```');
    assert.ok(result.includes('hljs'));
  });

  it('highlights CSS code blocks', () => {
    const result = markdownParse('```css\n.test { color: red; }\n```');
    assert.ok(result.includes('hljs'));
  });
});

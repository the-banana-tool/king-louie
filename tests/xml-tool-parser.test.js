const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  XML_TOOL_NAMES,
  extractXmlToolBlocks,
  stripTrailingOpenToolTag
} = require('../src/xml-tool-parser');

describe('XML_TOOL_NAMES mapping', () => {
  it('maps all bash aliases to Bash', () => {
    for (const alias of ['bash', 'powershell', 'shell', 'terminal', 'cmd']) {
      assert.strictEqual(XML_TOOL_NAMES[alias], 'Bash', `${alias} should map to Bash`);
    }
  });

  it('maps core tool names to canonical form', () => {
    assert.strictEqual(XML_TOOL_NAMES['read'], 'Read');
    assert.strictEqual(XML_TOOL_NAMES['write'], 'Write');
    assert.strictEqual(XML_TOOL_NAMES['edit'], 'Edit');
    assert.strictEqual(XML_TOOL_NAMES['grep'], 'Grep');
    assert.strictEqual(XML_TOOL_NAMES['glob'], 'Glob');
    assert.strictEqual(XML_TOOL_NAMES['git'], 'Git');
  });

  it('maps web aliases correctly', () => {
    assert.strictEqual(XML_TOOL_NAMES['webfetch'], 'WebFetch');
    assert.strictEqual(XML_TOOL_NAMES['fetch'], 'WebFetch');
    assert.strictEqual(XML_TOOL_NAMES['websearch'], 'WebSearch');
    assert.strictEqual(XML_TOOL_NAMES['search'], 'WebSearch');
  });

  it('maps remaining tools', () => {
    assert.strictEqual(XML_TOOL_NAMES['browser'], 'Browser');
    assert.strictEqual(XML_TOOL_NAMES['askuser'], 'AskUser');
    assert.strictEqual(XML_TOOL_NAMES['cron'], 'Cron');
    assert.strictEqual(XML_TOOL_NAMES['skill'], 'Skill');
  });
});

describe('extractXmlToolBlocks', () => {
  describe('single tool block extraction', () => {
    it('extracts a simple bash block', () => {
      const text = 'Here is the command:\n<bash>ls -la</bash>\nDone.';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'Bash');
      assert.strictEqual(toolBlocks[0].content, 'ls -la');
      assert.strictEqual(cleanText, 'Here is the command:\n\nDone.');
    });

    it('extracts a powershell block and maps to Bash', () => {
      const text = '<powershell>Get-Content "file.txt"</powershell>';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'Bash');
      assert.strictEqual(toolBlocks[0].content, 'Get-Content "file.txt"');
      assert.strictEqual(cleanText, '');
    });

    it('extracts a read block', () => {
      const text = 'Let me read the file:\n<read>/tmp/config.json</read>';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'Read');
      assert.strictEqual(toolBlocks[0].content, '/tmp/config.json');
    });

    it('extracts a search block and maps to WebSearch', () => {
      const text = '<search>how to parse XML in JavaScript</search>';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'WebSearch');
    });

    it('extracts a fetch block and maps to WebFetch', () => {
      const text = '<fetch>https://example.com/api</fetch>';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'WebFetch');
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase tag names', () => {
      const text = '<BASH>echo hello</BASH>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'Bash');
      assert.strictEqual(toolBlocks[0].content, 'echo hello');
    });

    it('handles mixed-case tag names', () => {
      const text = '<Bash>echo hello</Bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'Bash');
    });

    it('handles mixed-case aliases', () => {
      const text = '<PowerShell>Get-Process</PowerShell>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].toolName, 'Bash');
    });
  });

  describe('multiple tool blocks', () => {
    it('extracts multiple different tool blocks', () => {
      const text = 'First:\n<bash>ls</bash>\nThen:\n<read>/tmp/a.txt</read>\nDone.';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 2);
      assert.strictEqual(toolBlocks[0].toolName, 'Bash');
      assert.strictEqual(toolBlocks[0].content, 'ls');
      assert.strictEqual(toolBlocks[1].toolName, 'Read');
      assert.strictEqual(toolBlocks[1].content, '/tmp/a.txt');
      assert.ok(!cleanText.includes('<bash>'));
      assert.ok(!cleanText.includes('<read>'));
    });

    it('extracts multiple blocks of the same tool', () => {
      const text = '<bash>echo 1</bash>\n<bash>echo 2</bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 2);
      assert.strictEqual(toolBlocks[0].content, 'echo 1');
      assert.strictEqual(toolBlocks[1].content, 'echo 2');
    });

    it('extracts a mix of aliases', () => {
      const text = '<bash>ls</bash>\n<powershell>Get-ChildItem</powershell>\n<shell>pwd</shell>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 3);
      assert.ok(toolBlocks.every(b => b.toolName === 'Bash'));
    });
  });

  describe('multiline content', () => {
    it('extracts blocks with multiline content', () => {
      const text = '<bash>\ncd /tmp\nls -la\necho "done"\n</bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].content, 'cd /tmp\nls -la\necho "done"');
    });

    it('extracts blocks with code and markdown around them', () => {
      const text = 'I will run this command:\n\n<bash>\ngit status\ngit log --oneline -5\n</bash>\n\nHere are the results.';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.ok(toolBlocks[0].content.includes('git status'));
      assert.ok(cleanText.includes('I will run this command'));
      assert.ok(cleanText.includes('Here are the results'));
    });
  });

  describe('content trimming', () => {
    it('trims whitespace from extracted content', () => {
      const text = '<bash>  ls -la  </bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks[0].content, 'ls -la');
    });

    it('trims leading/trailing newlines from content', () => {
      const text = '<bash>\n\nls -la\n\n</bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks[0].content, 'ls -la');
    });

    it('trims the resulting clean text', () => {
      const text = '  <bash>ls</bash>  ';
      const { cleanText } = extractXmlToolBlocks(text);

      assert.strictEqual(cleanText, '');
    });
  });

  describe('no tool blocks', () => {
    it('returns empty array when no tool tags are present', () => {
      const text = 'Just a normal message with no tool calls.';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 0);
      assert.strictEqual(cleanText, text);
    });

    it('does not match unknown tag names', () => {
      const text = '<div>hello</div><span>world</span>';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 0);
      assert.strictEqual(cleanText, text);
    });

    it('returns empty array for empty string', () => {
      const { cleanText, toolBlocks } = extractXmlToolBlocks('');

      assert.strictEqual(toolBlocks.length, 0);
      assert.strictEqual(cleanText, '');
    });
  });

  describe('edge cases', () => {
    it('does not match mismatched open/close tags', () => {
      const text = '<bash>ls</read>';
      const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 0);
      assert.strictEqual(cleanText, text);
    });

    it('handles empty tool blocks', () => {
      const text = '<bash></bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].content, '');
    });

    it('handles tool blocks with special characters', () => {
      const text = '<bash>echo "hello & world" | grep \'test\' > /dev/null 2>&1</bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.strictEqual(toolBlocks[0].content, 'echo "hello & world" | grep \'test\' > /dev/null 2>&1');
    });

    it('handles tool blocks containing nested angle brackets', () => {
      const text = '<bash>echo "<div>not a tag</div>"</bash>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.ok(toolBlocks[0].content.includes('<div>'));
    });

    it('handles content with markdown code fences inside tool block', () => {
      const text = '<write>\n```js\nconsole.log("hello");\n```\n</write>';
      const { toolBlocks } = extractXmlToolBlocks(text);

      assert.strictEqual(toolBlocks.length, 1);
      assert.ok(toolBlocks[0].content.includes('console.log'));
    });

    it('is idempotent — calling twice with no tool blocks is safe', () => {
      const text = 'Hello world';
      const first = extractXmlToolBlocks(text);
      const second = extractXmlToolBlocks(first.cleanText);

      assert.strictEqual(second.cleanText, text);
      assert.strictEqual(second.toolBlocks.length, 0);
    });

    it('is idempotent — calling on already-extracted text returns no blocks', () => {
      const text = 'Before\n<bash>ls</bash>\nAfter';
      const first = extractXmlToolBlocks(text);
      const second = extractXmlToolBlocks(first.cleanText);

      assert.strictEqual(second.toolBlocks.length, 0);
      assert.strictEqual(second.cleanText, first.cleanText);
    });
  });

  describe('regex global flag reset', () => {
    it('works correctly on consecutive calls (lastIndex reset)', () => {
      // The 'g' flag on a regex persists lastIndex between calls.
      // Verify extractXmlToolBlocks resets it properly.
      const text1 = '<bash>echo 1</bash>';
      const text2 = '<bash>echo 2</bash>';

      const r1 = extractXmlToolBlocks(text1);
      const r2 = extractXmlToolBlocks(text2);

      assert.strictEqual(r1.toolBlocks.length, 1);
      assert.strictEqual(r1.toolBlocks[0].content, 'echo 1');
      assert.strictEqual(r2.toolBlocks.length, 1);
      assert.strictEqual(r2.toolBlocks[0].content, 'echo 2');
    });

    it('handles alternating calls with and without tool blocks', () => {
      const r1 = extractXmlToolBlocks('<bash>ls</bash>');
      const r2 = extractXmlToolBlocks('no tools here');
      const r3 = extractXmlToolBlocks('<read>file.txt</read>');

      assert.strictEqual(r1.toolBlocks.length, 1);
      assert.strictEqual(r2.toolBlocks.length, 0);
      assert.strictEqual(r3.toolBlocks.length, 1);
      assert.strictEqual(r3.toolBlocks[0].toolName, 'Read');
    });
  });
});

describe('stripTrailingOpenToolTag', () => {
  it('strips an unclosed bash tag at the end', () => {
    const text = 'Here is some text\n<bash>ls -la';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, 'Here is some text');
  });

  it('strips an unclosed tag with multiline content', () => {
    const text = 'Intro text\n<bash>\ncd /tmp\nls';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, 'Intro text');
  });

  it('strips an unclosed powershell tag', () => {
    const text = 'Checking:\n<powershell>Get-Child';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, 'Checking:');
  });

  it('does not strip from text with no open tags (post-extraction)', () => {
    // In real usage, extractXmlToolBlocks runs first and removes completed blocks.
    // stripTrailingOpenToolTag only sees the clean text.
    const text = 'Text\n\nMore text';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, text.trim());
  });

  it('does not strip unknown tags', () => {
    const text = 'Text\n<div>some content';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, text.trim());
  });

  it('handles text with no tags', () => {
    const text = 'Just plain text here';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, text);
  });

  it('handles empty string', () => {
    assert.strictEqual(stripTrailingOpenToolTag(''), '');
  });

  it('strips tag with empty content so far', () => {
    const text = 'Starting:\n<bash>';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, 'Starting:');
  });

  it('works on clean text after extraction — no completed tags remain', () => {
    // Real flow: extract first, then strip trailing open tag from cleanText
    const raw = '<bash>ls</bash>\nSome trailing text';
    const { cleanText } = extractXmlToolBlocks(raw);
    const result = stripTrailingOpenToolTag(cleanText);

    assert.strictEqual(result, 'Some trailing text');
  });

  it('strips only the trailing open tag from clean text after extraction', () => {
    // Real flow: first completed block extracted, then strip trailing open tag
    const raw = '<bash>ls</bash>\nNow:\n<read>/tmp/file';
    const { cleanText } = extractXmlToolBlocks(raw);
    // cleanText has the completed <bash> removed, but <read> is unclosed
    const result = stripTrailingOpenToolTag(cleanText);

    assert.strictEqual(result, 'Now:');
  });

  it('trims result whitespace', () => {
    const text = '  Hello  \n<bash>partial command';
    const result = stripTrailingOpenToolTag(text);

    assert.strictEqual(result, 'Hello');
  });
});

describe('streaming simulation', () => {
  it('progressively extracts tool blocks as text accumulates', () => {
    // Simulate chunks arriving over time
    let buffer = '';

    // Chunk 1: text before tool
    buffer += 'Let me check the files:\n';
    let r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 0);
    assert.strictEqual(stripTrailingOpenToolTag(r.cleanText), 'Let me check the files:');

    // Chunk 2: opening tag arrives
    buffer += '<bash>';
    r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 0);
    // The open tag should be stripped from display
    assert.strictEqual(stripTrailingOpenToolTag(r.cleanText), 'Let me check the files:');

    // Chunk 3: content streaming inside tag
    buffer += 'ls -la /tmp';
    r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 0);
    assert.strictEqual(stripTrailingOpenToolTag(r.cleanText), 'Let me check the files:');

    // Chunk 4: closing tag completes
    buffer += '</bash>';
    r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 1);
    assert.strictEqual(r.toolBlocks[0].toolName, 'Bash');
    assert.strictEqual(r.toolBlocks[0].content, 'ls -la /tmp');

    // Chunk 5: more text after
    buffer += '\nHere are the results.';
    r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 1);
    assert.ok(r.cleanText.includes('Here are the results'));
  });

  it('handles multiple tool blocks arriving sequentially', () => {
    let buffer = '';

    buffer += '<bash>ls</bash>';
    let r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 1);

    buffer += '\nNow reading:\n<read>';
    r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 1); // first still extracted
    assert.strictEqual(stripTrailingOpenToolTag(r.cleanText), 'Now reading:');

    buffer += '/tmp/data.json</read>';
    r = extractXmlToolBlocks(buffer);
    assert.strictEqual(r.toolBlocks.length, 2);
    assert.strictEqual(r.toolBlocks[1].toolName, 'Read');
    assert.strictEqual(r.toolBlocks[1].content, '/tmp/data.json');
  });

  it('deduplication key logic works correctly', () => {
    // Simulate the renderer's dedup approach using a Map
    const rendered = new Map();
    let buffer = '';

    buffer += '<bash>ls</bash>';
    let r = extractXmlToolBlocks(buffer);

    // First extraction: should render
    for (const block of r.toolBlocks) {
      const key = `resp1:${block.toolName}:${block.content.slice(0, 80)}`;
      if (!rendered.has(key)) {
        rendered.set(key, true);
      }
    }
    assert.strictEqual(rendered.size, 1);

    // Same buffer re-parsed (next chunk arrives): should NOT re-render
    buffer += '\nmore text';
    r = extractXmlToolBlocks(buffer);
    let newRenders = 0;
    for (const block of r.toolBlocks) {
      const key = `resp1:${block.toolName}:${block.content.slice(0, 80)}`;
      if (!rendered.has(key)) {
        rendered.set(key, true);
        newRenders++;
      }
    }
    assert.strictEqual(newRenders, 0, 'should not re-render same block');

    // New different block: should render
    buffer += '<bash>pwd</bash>';
    r = extractXmlToolBlocks(buffer);
    for (const block of r.toolBlocks) {
      const key = `resp1:${block.toolName}:${block.content.slice(0, 80)}`;
      if (!rendered.has(key)) {
        rendered.set(key, true);
        newRenders++;
      }
    }
    assert.strictEqual(newRenders, 1, 'should render the new block');
    assert.strictEqual(rendered.size, 2);
  });
});

describe('realistic LLM output patterns', () => {
  it('handles typical Claude non-agent output with explanation and tool calls', () => {
    const text = [
      "I'll help you check the project structure. Let me start by reading the directory:",
      '',
      '<bash>',
      'ls -la /home/user/project',
      '</bash>',
      '',
      'Now let me read the config file:',
      '',
      '<read>/home/user/project/package.json</read>',
      '',
      'Based on what I found, here is the summary.'
    ].join('\n');

    const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 2);
    assert.strictEqual(toolBlocks[0].toolName, 'Bash');
    assert.strictEqual(toolBlocks[0].content, 'ls -la /home/user/project');
    assert.strictEqual(toolBlocks[1].toolName, 'Read');
    assert.strictEqual(toolBlocks[1].content, '/home/user/project/package.json');
    assert.ok(cleanText.includes("I'll help you"));
    assert.ok(cleanText.includes('summary'));
    assert.ok(!cleanText.includes('<bash>'));
    assert.ok(!cleanText.includes('<read>'));
  });

  it('handles LLM using PowerShell on Windows', () => {
    const text = [
      "Let me try using PowerShell instead:",
      '',
      '<powershell>',
      'Get-Content "E:\\Programming\\banana-skills\\SKILLS.md"',
      '</powershell>',
      '',
      'Now let me look at the hello-world example to understand the structure:',
      '',
      '<powershell>',
      'Get-ChildItem "E:\\Programming\\banana-skills\\hello-world" -Recurse | Select-Object FullName, Length',
      '</powershell>'
    ].join('\n');

    const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 2);
    assert.ok(toolBlocks.every(b => b.toolName === 'Bash'));
    assert.ok(toolBlocks[0].content.includes('Get-Content'));
    assert.ok(toolBlocks[1].content.includes('Get-ChildItem'));
    assert.ok(!cleanText.includes('<powershell>'));
  });

  it('handles response that is entirely a single tool call', () => {
    const text = '<bash>cat README.md</bash>';
    const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 1);
    assert.strictEqual(cleanText, '');
  });

  it('handles LLM output with code fences around tool blocks (not inside them)', () => {
    // LLMs sometimes put backtick-fenced code alongside tool tags
    const text = 'Here is an example:\n```\nconst x = 1;\n```\n\n<bash>node -e "console.log(1)"</bash>';
    const { cleanText, toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 1);
    assert.ok(cleanText.includes('```'));
    assert.ok(cleanText.includes('const x = 1'));
  });

  it('handles grep with regex patterns that include angle brackets', () => {
    const text = '<grep>pattern with <brackets></grep>';
    const { toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 1);
    assert.strictEqual(toolBlocks[0].toolName, 'Grep');
    assert.ok(toolBlocks[0].content.includes('<brackets>'));
  });

  it('handles edit block with JSON-like content', () => {
    const text = '<edit>{"file": "test.js", "line": 5, "content": "const x = 42;"}</edit>';
    const { toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 1);
    assert.strictEqual(toolBlocks[0].toolName, 'Edit');
  });

  it('handles git block with common commands', () => {
    const text = 'Let me check the history:\n<git>log --oneline -10</git>';
    const { toolBlocks } = extractXmlToolBlocks(text);

    assert.strictEqual(toolBlocks.length, 1);
    assert.strictEqual(toolBlocks[0].toolName, 'Git');
    assert.strictEqual(toolBlocks[0].content, 'log --oneline -10');
  });
});

/**
 * Lightweight zero-dependency YAML parser for node config and runbook files.
 * Supports mappings, lists, strings (unquoted, single/double quoted), numbers, booleans, and comments.
 */

function parseScalar(str) {
  if (str === null || str === undefined) return null;
  const s = str.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;

  // Quoted strings
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  // Numbers
  if (/^-?\d+$/.test(s)) {
    const num = parseInt(s, 10);
    if (Number.isSafeInteger(num)) return num;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (!Number.isNaN(num)) return num;
  }

  // Inline array format: [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    // Split by comma ignoring commas inside quotes
    const items = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i];
      if ((char === '"' || char === "'") && (i === 0 || inner[i - 1] !== '\\')) {
        if (!inQuotes) { inQuotes = true; quoteChar = char; }
        else if (char === quoteChar) { inQuotes = false; }
        current += char;
      } else if (char === ',' && !inQuotes) {
        items.push(parseScalar(current));
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) items.push(parseScalar(current));
    return items;
  }

  // Inline object format: { a: b, c: d }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const obj = {};
    const pairs = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i];
      if ((char === '"' || char === "'") && (i === 0 || inner[i - 1] !== '\\')) {
        if (!inQuotes) { inQuotes = true; quoteChar = char; }
        else if (char === quoteChar) { inQuotes = false; }
        current += char;
      } else if (char === ',' && !inQuotes) {
        pairs.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) pairs.push(current);
    for (const p of pairs) {
      const colonIndex = p.indexOf(':');
      if (colonIndex !== -1) {
        const k = parseScalar(p.slice(0, colonIndex));
        const v = parseScalar(p.slice(colonIndex + 1));
        if (k !== null) obj[String(k)] = v;
      }
    }
    return obj;
  }

  // Remove trailing inline comments if unquoted
  const commentIdx = s.indexOf(' #');
  if (commentIdx !== -1) {
    return parseScalar(s.slice(0, commentIdx));
  }

  return s;
}

function getIndent(line) {
  let indent = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') indent++;
    else if (line[i] === '\t') indent += 2;
    else break;
  }
  return indent;
}

function stripComments(line) {
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === '"' || char === "'") && (i === 0 || line[i - 1] !== '\\')) {
      if (!inQuotes) { inQuotes = true; quoteChar = char; }
      else if (char === quoteChar) { inQuotes = false; }
    } else if (char === '#' && !inQuotes) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseYamlLines(lines, startIndex = 0, baseIndent = 0) {
  let idx = startIndex;
  let result = null; // Can become object or array
  let mode = null;   // 'object' or 'array'

  while (idx < lines.length) {
    const rawLine = lines[idx];
    const stripped = stripComments(rawLine);
    if (!stripped.trim()) {
      idx++;
      continue;
    }

    const indent = getIndent(rawLine);
    if (indent < baseIndent) {
      break; // Indent reduced, return to parent level
    }

    const line = stripped.trim();

    // Check array item
    if (line.startsWith('-')) {
      if (mode === 'object') break;
      mode = 'array';
      if (!result) result = [];

      const rest = line.slice(1).trim();

      // Case 1: "- run: [cmd, arg]" or "- key: value" (item is object)
      if (rest.includes(':') && !rest.startsWith('[') && !rest.startsWith('{')) {
        const itemLines = [`${' '.repeat(indent + 2)}${rest}`];
        idx++;
        while (idx < lines.length) {
          const nextRaw = lines[idx];
          if (!stripComments(nextRaw).trim()) { idx++; continue; }
          const nextIndent = getIndent(nextRaw);
          if (nextIndent > indent) {
            itemLines.push(nextRaw);
            idx++;
          } else {
            break;
          }
        }
        const parsedItem = parseYamlLines(itemLines, 0, indent + 2);
        result.push(parsedItem);
        continue;
      }

      // Case 2: "-" followed by block on next lines
      if (!rest) {
        idx++;
        // Read children indented further than current item
        let childIndent = -1;
        const childLines = [];
        while (idx < lines.length) {
          const nextRaw = lines[idx];
          if (!stripComments(nextRaw).trim()) { idx++; continue; }
          const nextIndent = getIndent(nextRaw);
          if (childIndent === -1 && nextIndent > indent) childIndent = nextIndent;
          if (nextIndent >= childIndent && childIndent > indent) {
            childLines.push(nextRaw);
            idx++;
          } else {
            break;
          }
        }
        if (childLines.length > 0) {
          result.push(parseYamlLines(childLines, 0, childIndent));
        } else {
          result.push(null);
        }
        continue;
      }

      // Case 3: scalar item "- value"
      result.push(parseScalar(rest));
      idx++;
      continue;
    }

    // Object entry "key: value" or "key:"
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      if (mode === 'array') break;
      mode = 'object';
      if (!result) result = {};

      const key = parseScalar(line.slice(0, colonIdx));
      const valStr = line.slice(colonIdx + 1).trim();

      if (valStr !== '') {
        result[key] = parseScalar(valStr);
        idx++;
      } else {
        // Child block
        idx++;
        let childIndent = -1;
        const childLines = [];
        while (idx < lines.length) {
          const nextRaw = lines[idx];
          if (!stripComments(nextRaw).trim()) { idx++; continue; }
          const nextIndent = getIndent(nextRaw);
          if (childIndent === -1 && nextIndent > indent) childIndent = nextIndent;
          if (nextIndent >= childIndent && childIndent > indent) {
            childLines.push(nextRaw);
            idx++;
          } else {
            break;
          }
        }
        if (childLines.length > 0) {
          result[key] = parseYamlLines(childLines, 0, childIndent);
        } else {
          result[key] = null;
        }
      }
      continue;
    }

    idx++;
  }

  return result;
}

function parseYaml(yamlString) {
  if (typeof yamlString !== 'string') return null;
  const lines = yamlString.split(/\r?\n/);
  return parseYamlLines(lines, 0, 0);
}

module.exports = { parseYaml, parseScalar };

// tests/helpers/example-fixture.js
// Runs the example runbooks with their programs faked (fleet stage 6 spec
// §4.4). The YAML text is never edited: the parsed runbook is rewritten,
// written back as JSON (which is valid YAML) and then loaded by the real
// RunbookEngine.
const fs = require('fs');
const path = require('path');
const { parseYaml } = require('../../src/platform/yaml');

const POSIX = process.platform !== 'win32';

// The body of every fake program. TMP and FAKE are prepended per fake.
const FAKE_BODY = `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(TMP, 'calls.jsonl'), JSON.stringify({ fake: FAKE, argv }) + '\\n');
const selectors = [FAKE, ...argv.filter((a) => /^[A-Za-z0-9_-]+$/.test(a)).map((a) => FAKE + '@' + a)];
const failFile = selectors.map((s) => path.join(TMP, 'fail', s)).find((f) => fs.existsSync(f));
if (failFile) {
  const [first, ...rest] = fs.readFileSync(failFile, 'utf8').split('\\n');
  process.stderr.write(rest.join('\\n'));
  process.exit(Number.parseInt(first, 10) || 1);
}
process.stdout.write(FAKE + ': ok\\n');
`;

function makeFakes(tmp, names) {
  const dir = path.join(tmp, 'fakes');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'fail'), { recursive: true });
  const files = {};
  for (const name of new Set([...names, 'npm-cli'])) {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, `const TMP = ${JSON.stringify(tmp)};\nconst FAKE = ${JSON.stringify(name)};\n${FAKE_BODY}`);
    files[name] = file;
  }
  return files;
}

function prepareRunbook(file, { tmp, programs = {}, prefixes = {}, urls = {} }) {
  const runbook = parseYaml(fs.readFileSync(file, 'utf8'));
  const hits = new Set();
  const longestFirst = (map) => Object.keys(map).sort((a, b) => b.length - a.length);
  const prefixKeys = longestFirst(prefixes);
  const urlKeys = longestFirst(urls);
  const swapPrefix = (value) => {
    for (const key of prefixKeys) {
      if (value.startsWith(key)) {
        hits.add(key);
        return prefixes[key] + value.slice(key.length);
      }
    }
    return value;
  };

  for (const step of runbook.steps) {
    if (Array.isArray(step.run)) {
      const [program, ...rest] = step.run;
      let head = [program];
      if (Object.prototype.hasOwnProperty.call(programs, program)) {
        hits.add(program);
        const target = programs[program];
        head = typeof target === 'string'
          ? [process.execPath, path.join(tmp, 'fakes', `${target}.js`)]
          : [target.path];
      }
      step.run = [...head, ...rest.map(swapPrefix)];
    } else if (step.check && typeof step.check.http_get === 'string') {
      const key = urlKeys.find((k) => step.check.http_get.startsWith(k));
      if (key) {
        hits.add(key);
        step.check.http_get = urls[key] + step.check.http_get.slice(key.length);
      }
    }
  }

  const config = path.join(tmp, 'config');
  const dir = path.join(config, 'runbooks');
  fs.mkdirSync(dir, { recursive: true });
  if (POSIX) {
    fs.chmodSync(config, 0o755);
    fs.chmodSync(dir, 0o755);
  }
  const out = path.join(dir, `${runbook.name}.yaml`);
  fs.writeFileSync(out, JSON.stringify(runbook, null, 2));
  if (POSIX) fs.chmodSync(out, 0o644);
  return { name: runbook.name, file: out, hits };
}

function readCalls(tmp) {
  const file = path.join(tmp, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = { prepareRunbook, makeFakes, readCalls };

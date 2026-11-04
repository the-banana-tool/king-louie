// detectOldProfile out of the main process (attach stage 2 §6.5). The read takes
// every message of the old store synchronously, and the window is served by the
// thread it would stall, so it runs in a child of this same binary, with
// ELECTRON_RUN_AS_NODE=1 as the PDF and embed workers do. Requests go on stdin;
// the answer is one marked line on stdout, since a logger may write there too.
//
// Never rejects, and a read that failed never says "nothing here": a failure is
// `found`, with schemaProblem saying why, as detectOldProfile answers for a store
// it cannot read. Not killed when the app closes: a read cut off would leave its
// history snapshot in the temp dir, and it ends by itself.
const { spawn: spawnDefault } = require('child_process');
const { detectOldProfile } = require('./profile-backup');
const { shown } = require('../service/commands/io');

const MARK = 'KL_OLD_PROFILE ';
// Past any profile measured (a 100,000-message store reads in seconds); killing a
// read is the last resort, so this is far from the normal case.
const READ_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 1024 * 1024;

function problem(text) {
  return {
    found: true, chats: 0, messages: 0, cases: 0, bytes: 0,
    schemaProblem: shown(text, 400), customCasesRoot: null, customCases: 0
  };
}

function parseAnswer(stdout) {
  const line = String(stdout).split(/\r?\n/).reverse().find((l) => l.startsWith(MARK));
  if (!line) return null;
  try {
    const answer = JSON.parse(line.slice(MARK.length));
    return answer && typeof answer === 'object' && typeof answer.found === 'boolean' ? answer : null;
  } catch {
    return null;
  }
}

function detectOldProfileApart(userDataDir, {
  env = process.env, spawn = spawnDefault, execPath = process.execPath, timeoutMs = READ_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(execPath, [__filename], {
        // The whole environment: the read needs the temp dir and the home a `~`
        // in a cases root means. The host's cases root goes in the request.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch (err) {
      resolve(problem(`The old profile could not be read: ${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const take = (acc, chunk) => (acc.length >= OUTPUT_CAP ? acc : acc + String(chunk).slice(0, OUTPUT_CAP - acc.length));
    child.stdout.on('data', (chunk) => { stdout = take(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = take(stderr, chunk); });
    // Ref'd: it keeps the process alive while the child runs.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    child.on('error', (err) => finish(problem(`The old profile could not be read: ${err.message}`)));
    child.on('close', (code) => {
      if (timedOut) { finish(problem('The read of the old profile did not finish in time.')); return; }
      const answer = code === 0 ? parseAnswer(stdout) : null;
      if (answer) { finish(answer); return; }
      const why = String(stderr).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.includes('ExperimentalWarning'));
      finish(problem(`The old profile could not be read: ${why || `the reader ended with code ${code}`}`));
    });
    if (child.stdin) {
      // A child that died at once closes the pipe: `close` above answers.
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ userDataDir, casesRoot: (env && env.KL_CASES_ROOT) || null }));
    }
  });
}

async function childMain() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { userDataDir, casesRoot } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const answer = await detectOldProfile(userDataDir, { env: casesRoot ? { KL_CASES_ROOT: casesRoot } : {} });
  process.stdout.write(`\n${MARK}${JSON.stringify(answer)}\n`, () => process.exit(0));
}

if (require.main === module) {
  childMain().catch((err) => {
    process.stderr.write(`${err && err.message}\n`);
    process.exit(1);
  });
}

module.exports = { detectOldProfileApart };

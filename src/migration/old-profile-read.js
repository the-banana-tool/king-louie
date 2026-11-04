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
const { createSafeReader } = require('./desktop-source');
const { readHistoryChats } = require('./desktop-history');
const { shown } = require('../service/commands/io');

const MARK = 'KL_OLD_PROFILE ';
const CHAT_MARK = 'KL_HISTORY_CHAT ';
const END_MARK = 'KL_HISTORY_END ';
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
        // in a cases root means. The host's own wins, and its cases root goes in
        // the request.
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
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

// The plan's read of every message, in a child too (final review, minor 16). Decrypting
// stays in the main process, where safeStorage is, and needs no chat. One marked line
// per chat, parsed as it arrives, so the window never holds a whole profile's JSON in
// one go. Answers as readHistoryChats does; whatever fails is an attention row the
// move refuses on, never fewer chats.
function readHistoryApart({ userDataDir, env = process.env, spawn = spawnDefault, execPath = process.execPath, timeoutMs = READ_TIMEOUT_MS }) {
  const failed = (why) => ({ found: true, chats: [], attention: [{ category: 'source', key: 'history.sqlite', note: `could not be read (${why}); close any other King Louie and try again` }] });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(execPath, [__filename], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (err) {
      resolve(failed(err.message));
      return;
    }
    const chats = [];
    let end = null;
    let broken = null;
    let tail = '';
    let stderr = '';
    let timedOut = false;
    const line = (text) => {
      try {
        if (text.startsWith(CHAT_MARK)) chats.push(JSON.parse(text.slice(CHAT_MARK.length)));
        else if (text.startsWith(END_MARK)) end = JSON.parse(text.slice(END_MARK.length));
      } catch {
        broken = 'a line from the reader did not parse';
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      let from = 0;
      for (let at = chunk.indexOf('\n'); at !== -1; at = chunk.indexOf('\n', from)) {
        line((tail + chunk.slice(from, at)).replace(/\r$/, ''));
        tail = '';
        from = at + 1;
      }
      tail += chunk.slice(from);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < OUTPUT_CAP) stderr += String(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    child.on('error', (err) => finish(failed(err.message)));
    child.on('close', (code) => {
      if (timedOut) { finish(failed('the read did not finish in time')); return; }
      if (code !== 0 || !end || broken || end.chats !== chats.length) {
        const why = broken || String(stderr).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.includes('ExperimentalWarning'));
        finish(failed(why || `the reader ended with code ${code}`));
        return;
      }
      finish({ found: end.found, chats, attention: end.attention });
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ history: true, userDataDir }));
    }
  });
}

const written = (text) => new Promise((resolve) => { process.stdout.write(text, resolve); });

async function historyMain(userDataDir) {
  const { found, chats, attention } = await readHistoryChats({ reader: createSafeReader({ root: userDataDir }) });
  for (const chat of chats) await written(`\n${CHAT_MARK}${JSON.stringify(chat)}\n`);
  await written(`\n${END_MARK}${JSON.stringify({ found, attention, chats: chats.length })}\n`);
  process.exit(0);
}

async function childMain() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { userDataDir, casesRoot, history } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (history === true) {
    await historyMain(userDataDir);
    return;
  }
  const answer = await detectOldProfile(userDataDir, { env: casesRoot ? { KL_CASES_ROOT: casesRoot } : {} });
  process.stdout.write(`\n${MARK}${JSON.stringify(answer)}\n`, () => process.exit(0));
}

if (require.main === module) {
  childMain().catch((err) => {
    process.stderr.write(`${err && err.message}\n`);
    process.exit(1);
  });
}

module.exports = { detectOldProfileApart, readHistoryApart };

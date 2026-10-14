// A check that never ends by itself, with a child of its own. Each writes
// its pid to the folder named by the first argument, then sleeps.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = process.argv[2];
const role = process.argv[3] || 'parent';
fs.writeFileSync(path.join(dir, `${role}.pid`), String(process.pid));
if (role === 'parent') spawn(process.execPath, [__filename, dir, 'child'], { stdio: 'inherit' });
setTimeout(() => {}, 60000);

// A check that fails.
process.stdout.write('0 passing\n');
process.stderr.write('1 failing\n');
process.exit(1);

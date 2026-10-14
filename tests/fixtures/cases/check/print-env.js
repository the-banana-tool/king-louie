// Prints the names of the environment variables it was given, never a value.
process.stdout.write(`${Object.keys(process.env).sort().join('\n')}\n`);

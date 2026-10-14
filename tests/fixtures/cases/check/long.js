// Prints more than a run keeps: a head that is dropped and a tail that is kept.
process.stdout.write(`HEAD-OF-OUTPUT\n${'x'.repeat(9000)}\nTAIL-OF-OUTPUT\n`);
process.stderr.write(`HEAD-OF-ERRORS\n${'y'.repeat(9000)}\nTAIL-OF-ERRORS\n`);

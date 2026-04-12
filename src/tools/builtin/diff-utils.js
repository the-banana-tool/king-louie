/**
 * Minimal unified diff generator for Edit/Write tool results.
 *
 * Produces a human-readable unified diff string that the renderer
 * can display with syntax highlighting. No external dependencies.
 */

/**
 * Generate a unified diff between two strings.
 * @param {string} oldText - original file content
 * @param {string} newText - modified file content
 * @param {string} filePath - file path for the diff header
 * @param {number} [contextLines=3] - lines of context around changes
 * @returns {string} unified diff string
 */
function generateUnifiedDiff(oldText, newText, filePath, contextLines = 3) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Simple LCS-based diff for line-level changes
  const hunks = computeHunks(oldLines, newLines, contextLines);

  if (hunks.length === 0) return '';

  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`
  ];

  const diffLines = [];
  for (const hunk of hunks) {
    diffLines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      diffLines.push(line);
    }
  }

  return [...header, ...diffLines].join('\n');
}

/**
 * Compute diff hunks between old and new line arrays.
 */
function computeHunks(oldLines, newLines, contextLines) {
  // Find changed regions using a simple forward scan
  const changes = [];
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      oi++;
      ni++;
      continue;
    }

    // Found a difference — find extent
    const changeStart = { old: oi, new: ni };

    // Scan forward to find where lines match again
    let matched = false;
    const maxLook = Math.max(oldLines.length - oi, newLines.length - ni);
    for (let look = 1; look <= maxLook && !matched; look++) {
      // Check if old[oi+look] matches new[ni+look]
      for (let d = 0; d <= look; d++) {
        const tryOi = oi + d;
        const tryNi = ni + (look - d);
        if (tryOi < oldLines.length && tryNi < newLines.length && oldLines[tryOi] === newLines[tryNi]) {
          changes.push({
            oldStart: changeStart.old,
            oldEnd: tryOi,
            newStart: changeStart.new,
            newEnd: tryNi
          });
          oi = tryOi;
          ni = tryNi;
          matched = true;
          break;
        }
        const tryOi2 = oi + (look - d);
        const tryNi2 = ni + d;
        if (tryOi2 < oldLines.length && tryNi2 < newLines.length && oldLines[tryOi2] === newLines[tryNi2]) {
          changes.push({
            oldStart: changeStart.old,
            oldEnd: tryOi2,
            newStart: changeStart.new,
            newEnd: tryNi2
          });
          oi = tryOi2;
          ni = tryNi2;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      // Remaining lines are all different
      changes.push({
        oldStart: changeStart.old,
        oldEnd: oldLines.length,
        newStart: changeStart.new,
        newEnd: newLines.length
      });
      break;
    }
  }

  if (changes.length === 0) return [];

  // Merge nearby changes and build hunks with context
  const hunks = [];
  for (const change of changes) {
    const ctxStart = Math.max(0, change.oldStart - contextLines);
    const ctxEnd = Math.min(oldLines.length, change.oldEnd + contextLines);
    const newCtxStart = Math.max(0, change.newStart - contextLines);
    const newCtxEnd = Math.min(newLines.length, change.newEnd + contextLines);

    const lines = [];

    // Leading context
    for (let i = ctxStart; i < change.oldStart; i++) {
      lines.push(` ${oldLines[i]}`);
    }
    // Removed lines
    for (let i = change.oldStart; i < change.oldEnd; i++) {
      lines.push(`-${oldLines[i]}`);
    }
    // Added lines
    for (let i = change.newStart; i < change.newEnd; i++) {
      lines.push(`+${newLines[i]}`);
    }
    // Trailing context
    for (let i = change.oldEnd; i < ctxEnd; i++) {
      lines.push(` ${oldLines[i]}`);
    }

    hunks.push({
      oldStart: ctxStart + 1,
      oldCount: (change.oldEnd - ctxStart) + Math.min(contextLines, oldLines.length - change.oldEnd),
      newStart: newCtxStart + 1,
      newCount: (change.newEnd - newCtxStart) + Math.min(contextLines, newLines.length - change.newEnd),
      lines
    });
  }

  return hunks;
}

/**
 * Count lines added and removed from a diff string.
 */
function countDiffStats(diffStr) {
  if (!diffStr) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diffStr.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

module.exports = { generateUnifiedDiff, countDiffStats };

// Narrows a desktop import to one case (personal node spec §9, "Moving one
// case"): that case's directory and the chats whose caseId is that case's id,
// and nothing else. A filter on the inventory readDesktopSource built, so the
// importer, its walker and its checks are the ones a whole-profile import
// uses; every other list in the inventory is emptied, so no settings,
// secrets, memory, cron jobs or other chats and cases are planned.
const { parseCaseYaml } = require('../cases/case-store');

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// case.yaml of one listed case, through the source's own safe reader
// (caseFiles(dir) lists only what the walker accepted). null when it is
// missing, unreadable or not a case.yaml with an id.
function readCaseMeta(caseFiles, dir) {
  const file = caseFiles(dir).find((f) => f.relPath === 'case.yaml');
  if (!file) return null;
  const r = file.read();
  if (!r.ok) return null;
  try {
    return parseCaseYaml(r.data.toString('utf8'));
  } catch {
    return null;
  }
}

// `caseRef` is a case directory name, or the `id` in a directory's
// case.yaml. A directory name wins over an id; an id two directories share
// is refused rather than guessed.
function filterInventoryToCase({ inventory, getValue, caseFiles, caseRef }) {
  const ref = String(caseRef || '').trim();
  if (!ref) throw coded('CASE_NOT_FOUND', 'No case was named.');
  const listed = Array.isArray(inventory && inventory.cases) ? inventory.cases : [];
  const metas = new Map(listed.map((c) => [c.dir, readCaseMeta(caseFiles, c.dir)]));
  let chosen = listed.find((c) => c.dir === ref);
  if (!chosen) {
    const byId = listed.filter((c) => metas.get(c.dir) && String(metas.get(c.dir).id) === ref);
    if (byId.length > 1) throw coded('CASE_AMBIGUOUS', `More than one case directory has the id ${ref} (${byId.map((c) => c.dir).join(', ')}); name the directory.`);
    chosen = byId[0];
  }
  if (!chosen) {
    throw coded('CASE_NOT_FOUND', inventory && inventory.customCasesRoot
      ? `No case ${ref}: the desktop keeps its cases under a custom cases.root (${inventory.customCasesRoot}), which an import does not read.`
      : `No case ${ref} in the desktop profile (by directory name or case id).`);
  }
  const meta = metas.get(chosen.dir);
  if (!meta) throw coded('CASE_UNREADABLE', `The case directory ${chosen.dir} has no readable case.yaml with an id, so its chats cannot be found.`);
  const caseId = String(meta.id);

  const chats = (Array.isArray(inventory.chats) ? inventory.chats : []).filter((c) => {
    const chat = c && getValue('chat', c.id);
    return Boolean(chat) && chat.caseId === caseId;
  });

  // Every other list emptied (the `excluded` notes too: nothing else is
  // offered, so there is nothing to say stays behind), every flag off; only
  // the scalar fields (installId, sourceVersion, secrets) are kept.
  const out = {};
  for (const [key, value] of Object.entries(inventory)) {
    if (Array.isArray(value)) out[key] = [];
    else if (typeof value === 'boolean') out[key] = false;
    else out[key] = value;
  }
  out.customCasesRoot = null;
  out.chats = chats;
  out.cases = [chosen];

  return { inventory: out, caseId, caseDir: chosen.dir, chatIds: chats.map((c) => c.id), meta };
}

module.exports = { filterInventoryToCase };

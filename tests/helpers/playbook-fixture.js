// tests/helpers/playbook-fixture.js
// An invented playbook package (cases stage 6) and helpers that write it to
// disk, as a plain folder or as a git repository. All values are invented;
// URLs are on example.com.
const fs = require('fs');
const path = require('path');
const git = require('../../src/cases/git');

const PLAYBOOK_YAML = [
  'name: land-sale',
  'version: "1.2.0"',
  'title: Sell a parcel of land',
  'description: Method for selling vacant land through agents and direct buyers.',
  'caseType: general',
  'executors: [web, phone-agent, owner]',
  'gatingQuestions:',
  '  - id: floor-price',
  '    text: What is the lowest price you would accept?',
  '    fact: { subject: property, attr: floor-price }',
  '    answerable: owner',
  '    required: true',
  '    briefField: hardConstraints',
  '    category: financial',
  '  - id: financing',
  '    text: Will you consider seller financing?',
  '    fact: { subject: property, attr: financing-allowed }',
  '    answerable: owner',
  '    required: false',
  '    options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]',
  '  - id: parcel-id',
  '    text: What is the parcel id of the lot?',
  '    fact: { subject: property, attr: parcel-id }',
  '    answerable: web',
  '    changes: Every records lookup keys on it',
  '    how: Search the assessor records by address',
  'materialityDefaults: { tell: [offers, deadline-risk], ignore: [no-answer] }',
  'budgetDefaults: { usd: 10, contactsPerDay: 5, questionsPerDay: 4 }',
  ''
].join('\n');

const STEPS_MD = [
  '# Land sale',
  '',
  'Work through these in order unless a step says otherwise.',
  '',
  '## 1. Confirm the parcel {#confirm-parcel}',
  '- executor: web',
  '- establishes: property.parcel-id, property.acreage',
  '- needs: property.county',
  '',
  'Search the assessor by address; cite the parcel page in sources/.',
  '',
  '## 2. Call buyers',
  '- executor: phone-agent',
  '- establishes: buyers.interest',
  '- optional: true',
  '',
  'Call the buyers on the list; never give the address before they are verified.',
  ''
].join('\n');

const BRIEF_RULES_MD = [
  '- Cite the recorded plat for acreage.',
  '',
  '## phone-agent',
  '- Give no address until the buyer is verified.',
  ''
].join('\n');

const SOURCES_MD = [
  'All URLs below are placeholders on example.com.',
  '',
  '- County recorder: https://records.example.com/search',
  ''
].join('\n');

function packageFiles(overrides = {}) {
  return {
    'playbook.yaml': PLAYBOOK_YAML,
    'steps.md': STEPS_MD,
    'briefRules.md': BRIEF_RULES_MD,
    'sources.md': SOURCES_MD,
    ...overrides
  };
}

// Writes files (null removes one) into dir, creating folders as needed.
function writePackage(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(packageFiles(overrides))) {
    const file = path.join(dir, rel);
    if (text === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

// Commit identity, passed through runGit's `env` option (never as leading
// `-c` args: C6 ruling C6-gitargs has runGit/runGitSync refuse any argument
// whose first element starts with "-", and refuse caller env GIT_* keys
// other than the commit identity ones). git.js's CALLER_GIT_ENV_RE allows
// exactly GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL.
const GIT_ID = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

// A git repository holding the package at its top level, one commit.
async function makeGitPackage(dir, overrides = {}) {
  writePackage(dir, overrides);
  await git.runGit(dir, ['init', '-q']);
  await git.runGit(dir, ['add', '-A']);
  await git.runGit(dir, ['commit', '-q', '-m', 'playbook'], { env: GIT_ID });
  return dir;
}

// Rewrites files in a git package and commits them.
async function commitPackage(dir, overrides, message = 'update') {
  writePackage(dir, overrides);
  await git.runGit(dir, ['add', '-A']);
  await git.runGit(dir, ['commit', '-q', '-m', message], { env: GIT_ID });
}

// playbook.yaml text with one field replaced (a regex on the line).
function withYaml(pattern, replacement) {
  return PLAYBOOK_YAML.replace(pattern, replacement);
}

module.exports = {
  PLAYBOOK_YAML,
  STEPS_MD,
  BRIEF_RULES_MD,
  SOURCES_MD,
  GIT_ID,
  packageFiles,
  writePackage,
  makeGitPackage,
  commitPackage,
  withYaml
};

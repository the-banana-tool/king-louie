// src/cases/tokenize.js
// Tokenizer `kl-bm25-v1` (cases stage 5 spec §3.1), shared by the
// cross-case index, the duplicate gates and the case types. Frozen: a change
// here must bump TOKENIZER so every index rebuilds.
const TOKENIZER = 'kl-bm25-v1';

const STOPWORDS = Object.freeze(new Set([
  'an', 'as', 'at', 'be', 'by', 'do', 'he', 'if', 'in', 'is',
  'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'we',
  'all', 'and', 'any', 'are', 'but', 'can', 'did', 'for', 'from', 'had',
  'has', 'have', 'her', 'his', 'how', 'its', 'not', 'our', 'she', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'was',
  'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your'
]));

// NFKD, strip combining marks, lowercase, split on anything but [a-z0-9],
// drop tokens under 2 characters and stopwords, strip a plural `s` from
// tokens over 3 characters not ending in `ss`. Numbers stay.
function tokenize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

const tokenSet = (text) => new Set(tokenize(text));

module.exports = { TOKENIZER, STOPWORDS, tokenize, tokenSet };

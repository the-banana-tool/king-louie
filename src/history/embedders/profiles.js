// src/history/embedders/profiles.js
// Per-model text handling (recall spec §5.2): the query and document
// prefixes a model was trained with, and its pooling (read by the local
// backend). Matched by a substring of the model id, so the Hugging Face id
// "Xenova/bge-small-en-v1.5" and Ollama's "nomic-embed-text:latest" both
// match. Unknown models: mean pooling, no prefixes.
const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';
const PROFILES = Object.freeze([
  { match: 'bge-small-en', pooling: 'cls', queryPrefix: BGE_QUERY, docPrefix: '' },
  { match: 'bge-base-en', pooling: 'cls', queryPrefix: BGE_QUERY, docPrefix: '' },
  { match: 'nomic-embed-text', pooling: 'mean', queryPrefix: 'search_query: ', docPrefix: 'search_document: ' },
  { match: 'minilm', pooling: 'mean', queryPrefix: '', docPrefix: '' }
]);

function profileFor(model) {
  const id = String(model || '').toLowerCase();
  const hit = PROFILES.find((p) => id.includes(p.match));
  return hit
    ? { pooling: hit.pooling, queryPrefix: hit.queryPrefix, docPrefix: hit.docPrefix }
    : { pooling: 'mean', queryPrefix: '', docPrefix: '' };
}

function prefixTexts(model, texts, kind = 'document') {
  const p = profileFor(model);
  const prefix = kind === 'query' ? p.queryPrefix : p.docPrefix;
  return texts.map((t) => `${prefix}${t}`);
}

module.exports = { profileFor, prefixTexts };

// src/models/capabilities.js
// What a model can do, from the catalog (spec 2026-09-27 §4.5). Replaces
// InferenceRouter.getCapabilities and keeps its four keys, so its callers
// (agent runtime, case ingest) did not have to change.

// Case ingest sends a one-page PDF as a document only to these; the others
// get the page image. (Chat attachments also go to OpenAI as a file part;
// ingest keeps page images there.)
const PDF_DOCUMENT_PROVIDERS = Object.freeze(['anthropic', 'gemini']);

function capabilitiesOf(catalog, provider, model) {
  const p = String(provider || '').toLowerCase();
  const entry = catalog && model ? catalog.get(p, model) : null;
  if (!entry) {
    // Unknown: never claim it sees images, and do not refuse it tools.
    return { vision: false, toolCalling: true, streaming: true, pdfInput: false };
  }
  const vision = entry.input.includes('image');
  return {
    vision,
    toolCalling: entry.toolCall === true,
    streaming: true,
    pdfInput: vision && entry.input.includes('pdf') && PDF_DOCUMENT_PROVIDERS.includes(p)
  };
}

module.exports = { capabilitiesOf, PDF_DOCUMENT_PROVIDERS };

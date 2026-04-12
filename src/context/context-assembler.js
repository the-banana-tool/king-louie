const VectorStore = require('../memory/vector-store');
const { OpenAIEmbeddingProvider } = require('../memory/embedding-provider');

/**
 * ContextAssembler — dynamic context assembly with two modes:
 *
 * 1. **Deferred mode** (default, recommended for Anthropic):
 *    Core tools are always included with full schemas. All other tools are
 *    "deferred" — the LLM sees their names listed in the system prompt but
 *    not their schemas. It calls ToolSearch to load schemas on demand.
 *    This stabilizes the prompt for caching and eliminates per-turn embedding cost.
 *
 * 2. **Semantic mode** (legacy, for non-Anthropic providers):
 *    Embeds each tool description once at startup, then on each user turn
 *    makes a single embedding call to retrieve only relevant tools.
 *
 * Both modes keep a core set of tools always available and support the full
 * system prompt section assembly.
 */

// Tools that are always included with full schemas regardless of mode.
const CORE_TOOLS = new Set([
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'AskUser',
  'ToolSearch',
]);

// System prompt sections that are always included.
const CORE_SECTIONS = new Set([
  'environment',  // platform, shell, cwd — always needed
]);

// Minimum similarity score to include a non-core item (semantic mode only).
const MIN_TOOL_SIMILARITY = 0.25;
const MIN_SECTION_SIMILARITY = 0.20;

class ContextAssembler {
  /**
   * @param {object} options
   * @param {string} options.vectorStorePath  - path for the context vector store file
   * @param {string} options.openaiApiKey     - OpenAI API key for embeddings
   * @param {string} [options.embeddingModel] - model name (default: text-embedding-3-small)
   * @param {string} [options.mode]           - 'deferred' (default) or 'semantic'
   */
  constructor(options = {}) {
    this.vectorStore = new VectorStore(options.vectorStorePath);
    this.embeddingProvider = options.openaiApiKey
      ? new OpenAIEmbeddingProvider({
          apiKey: options.openaiApiKey,
          model: options.embeddingModel || 'text-embedding-3-small'
        })
      : null;

    // 'deferred' = core tools inline + ToolSearch for rest (cache-friendly)
    // 'semantic' = per-turn embedding-based tool selection (legacy)
    this.mode = options.mode || 'deferred';

    // In-memory registries: name → { definition, text }
    this._tools = new Map();
    this._sections = new Map();

    this._indexed = false;
  }

  // ──────────────────────────────────────────────
  // Indexing (called once at startup / when tools change)
  // ──────────────────────────────────────────────

  /**
   * Register all tool definitions and system prompt sections, then embed
   * any that aren't already in the vector store.
   *
   * @param {Array} toolDefinitions - from toolRegistry.getFunctionDefinitions()
   * @param {Array<{name: string, content: string}>} systemSections - named prompt sections
   */
  async index(toolDefinitions = [], systemSections = []) {
    // Register tools
    for (const def of toolDefinitions) {
      const textForEmbedding = `tool: ${def.name}. ${def.description}`;
      this._tools.set(def.name, { definition: def, text: textForEmbedding });
    }

    // Register sections
    for (const section of systemSections) {
      this._sections.set(section.name, { content: section.content, text: `system section: ${section.name}. ${section.content}` });
    }

    if (!this.embeddingProvider) {
      this._indexed = true;
      return;
    }

    // Collect items that need embedding (not yet in vector store)
    const toEmbed = [];
    const ids = [];

    for (const [name, { text }] of this._tools) {
      const vid = `tool:${name}`;
      if (!this.vectorStore.vectors[vid]) {
        toEmbed.push(text);
        ids.push(vid);
      }
    }

    for (const [name, { text }] of this._sections) {
      const vid = `section:${name}`;
      if (!this.vectorStore.vectors[vid]) {
        toEmbed.push(text);
        ids.push(vid);
      }
    }

    if (toEmbed.length > 0) {
      try {
        const embeddings = await this.embeddingProvider.embed(toEmbed);
        for (let i = 0; i < ids.length; i++) {
          if (embeddings[i]) {
            this.vectorStore.add(ids[i], embeddings[i]);
          }
        }
      } catch (err) {
        console.warn('[context-assembler] Failed to embed during indexing:', err.message);
      }
    }

    // Prune stale vectors whose tools/sections no longer exist
    const validIds = new Set([
      ...Array.from(this._tools.keys()).map(n => `tool:${n}`),
      ...Array.from(this._sections.keys()).map(n => `section:${n}`),
    ]);
    for (const vid of Object.keys(this.vectorStore.vectors)) {
      if ((vid.startsWith('tool:') || vid.startsWith('section:')) && !validIds.has(vid)) {
        this.vectorStore.remove(vid);
      }
    }

    this._indexed = true;
  }

  // ──────────────────────────────────────────────
  // Per-turn assembly
  // ──────────────────────────────────────────────

  /**
   * Assemble tools and system prompt sections for this turn.
   *
   * In 'deferred' mode (default): includes core tools with full schemas,
   * lists deferred tool names in the system prompt. No embedding call needed.
   * The LLM calls ToolSearch to load schemas on demand.
   *
   * In 'semantic' mode: makes one embedding call per turn to select
   * relevant tools via cosine similarity.
   *
   * @param {string} userMessage - the current user message
   * @param {object} [options]
   * @param {number} [options.maxTools=10]       - max tools to return (semantic mode)
   * @param {number} [options.maxSections=4]     - max sections to return
   * @param {string} [options.memoryContext='']   - pre-built memory context string
   * @returns {{ systemPrompt: string, tools: Array, allToolNames: string[] }}
   */
  async assemble(userMessage, options = {}) {
    if (this.mode === 'deferred') {
      return this._assembleDeferred(options);
    }
    return this._assembleSemantic(userMessage, options);
  }

  /**
   * Deferred mode: core tools with schemas + deferred tool names in prompt.
   * Zero embedding calls. Stable prompt enables prompt caching.
   */
  _assembleDeferred(options = {}) {
    const memoryContext = options.memoryContext || '';

    // Core tools get full schemas
    const selectedTools = [];
    const selectedToolNames = new Set();

    for (const name of CORE_TOOLS) {
      if (this._tools.has(name)) {
        selectedTools.push(this._tools.get(name).definition);
        selectedToolNames.add(name);
      }
    }

    // Deferred tools: everything not in core
    const deferredNames = Array.from(this._tools.keys()).filter(n => !selectedToolNames.has(n));

    // All sections included (stable for caching)
    const allSections = Array.from(this._sections.values()).map(s => s.content);

    // Build deferred tools announcement for system prompt
    const deferredSection = deferredNames.length > 0
      ? `The following deferred tools are available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n${deferredNames.join(', ')}`
      : '';

    const systemPrompt = [
      ...allSections,
      deferredSection,
      memoryContext
    ].filter(Boolean).join('\n\n');

    return {
      systemPrompt,
      tools: selectedTools,
      selectedToolNames: Array.from(selectedToolNames),
      availableToolNames: deferredNames,
    };
  }

  /**
   * Semantic mode (legacy): per-turn embedding-based tool selection.
   */
  async _assembleSemantic(userMessage, options = {}) {
    const maxTools = options.maxTools || 10;
    const maxSections = options.maxSections || 4;
    const memoryContext = options.memoryContext || '';

    // If no embedding provider, fall back to returning everything
    if (!this.embeddingProvider || !this._indexed) {
      return this._fallbackAll(memoryContext);
    }

    let queryVector;
    try {
      const embeddings = await this.embeddingProvider.embed([userMessage]);
      queryVector = embeddings?.[0];
    } catch (err) {
      console.warn('[context-assembler] Embedding failed, falling back to full context:', err.message);
      return this._fallbackAll(memoryContext);
    }

    if (!queryVector) {
      return this._fallbackAll(memoryContext);
    }

    // Single vector search across all indexed items
    const allResults = this.vectorStore.search(queryVector, this._tools.size + this._sections.size);

    // Partition results into tools and sections
    const toolScores = new Map();
    const sectionScores = new Map();

    for (const { id, similarity } of allResults) {
      if (id.startsWith('tool:')) {
        toolScores.set(id.replace('tool:', ''), similarity);
      } else if (id.startsWith('section:')) {
        sectionScores.set(id.replace('section:', ''), similarity);
      }
    }

    // Select tools: core always included, then top-K by similarity
    const selectedTools = [];
    const selectedToolNames = new Set();

    for (const name of CORE_TOOLS) {
      if (this._tools.has(name)) {
        selectedTools.push(this._tools.get(name).definition);
        selectedToolNames.add(name);
      }
    }

    // Ranked non-core tools
    const ranked = Array.from(toolScores.entries())
      .filter(([name]) => !selectedToolNames.has(name))
      .filter(([, score]) => score >= MIN_TOOL_SIMILARITY)
      .sort((a, b) => b[1] - a[1]);

    for (const [name] of ranked) {
      if (selectedTools.length >= maxTools) break;
      if (this._tools.has(name)) {
        selectedTools.push(this._tools.get(name).definition);
        selectedToolNames.add(name);
      }
    }

    // Select sections: core always included, then top-K by similarity
    const selectedSections = [];
    const selectedSectionNames = new Set();

    for (const name of CORE_SECTIONS) {
      if (this._sections.has(name)) {
        selectedSections.push(this._sections.get(name).content);
        selectedSectionNames.add(name);
      }
    }

    const rankedSections = Array.from(sectionScores.entries())
      .filter(([name]) => !selectedSectionNames.has(name))
      .filter(([, score]) => score >= MIN_SECTION_SIMILARITY)
      .sort((a, b) => b[1] - a[1]);

    for (const [name] of rankedSections) {
      if (selectedSections.length >= maxSections) break;
      if (this._sections.has(name)) {
        selectedSections.push(this._sections.get(name).content);
        selectedSectionNames.add(name);
      }
    }

    // Build system prompt from selected sections + memory
    const systemPrompt = [
      ...selectedSections,
      memoryContext
    ].filter(Boolean).join('\n\n');

    // Build list of all available (but not included) tools for the escape hatch
    const availableToolNames = Array.from(this._tools.keys()).filter(n => !selectedToolNames.has(n));

    return {
      systemPrompt,
      tools: selectedTools,
      selectedToolNames: Array.from(selectedToolNames),
      availableToolNames,
    };
  }

  /**
   * Retrieve specific tools by name (used by ToolSearch and RequestTools).
   * @param {string[]} toolNames
   * @returns {Array} tool definitions
   */
  getToolsByName(toolNames = []) {
    return toolNames
      .map(name => this._tools.get(name)?.definition)
      .filter(Boolean);
  }

  /**
   * Get all deferred (non-core) tool definitions.
   * Used by ToolSearch for keyword matching.
   * @returns {Array} tool definitions
   */
  getAllDeferredTools() {
    return Array.from(this._tools.entries())
      .filter(([name]) => !CORE_TOOLS.has(name))
      .map(([, entry]) => entry.definition);
  }

  /**
   * Fallback: return everything (used when embeddings are unavailable).
   */
  _fallbackAll(memoryContext = '') {
    const allTools = Array.from(this._tools.values()).map(t => t.definition);
    const allSections = Array.from(this._sections.values()).map(s => s.content);
    const systemPrompt = [...allSections, memoryContext].filter(Boolean).join('\n\n');

    return {
      systemPrompt,
      tools: allTools,
      selectedToolNames: Array.from(this._tools.keys()),
      availableToolNames: [],
    };
  }
}

module.exports = ContextAssembler;

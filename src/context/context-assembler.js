const VectorStore = require('../memory/vector-store');
const { OpenAIEmbeddingProvider } = require('../memory/embedding-provider');

/**
 * ContextAssembler — dynamic, per-turn context assembly using semantic search.
 *
 * Instead of sending the full system prompt + all tool definitions on every
 * message, we embed each tool description and each system prompt section once
 * at startup, then on each user turn we make a *single* embedding call for
 * the user message and search both indexes to retrieve only the relevant
 * tools and prompt sections.
 *
 * This cuts token overhead by 30-60 % while keeping a core set of tools
 * always available and an escape-hatch tool that lets the LLM request
 * additional tools mid-conversation.
 */

// Tools that are always included regardless of relevance score.
const CORE_TOOLS = new Set([
  'Bash',
  'Read',
  'AskUser',
]);

// System prompt sections that are always included.
const CORE_SECTIONS = new Set([
  'environment',  // platform, shell, cwd — always needed
]);

// Minimum similarity score to include a non-core item.
const MIN_TOOL_SIMILARITY = 0.25;
const MIN_SECTION_SIMILARITY = 0.20;

class ContextAssembler {
  /**
   * @param {object} options
   * @param {string} options.vectorStorePath  - path for the context vector store file
   * @param {string} options.openaiApiKey     - OpenAI API key for embeddings
   * @param {string} [options.embeddingModel] - model name (default: text-embedding-3-small)
   */
  constructor(options = {}) {
    this.vectorStore = new VectorStore(options.vectorStorePath);
    this.embeddingProvider = options.openaiApiKey
      ? new OpenAIEmbeddingProvider({
          apiKey: options.openaiApiKey,
          model: options.embeddingModel || 'text-embedding-3-small'
        })
      : null;

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
   * Assemble only the relevant tools and system prompt sections for this turn.
   * Makes ONE embedding call for the user message, then searches both indexes.
   *
   * @param {string} userMessage - the current user message
   * @param {object} [options]
   * @param {number} [options.maxTools=10]       - max tools to return (including core)
   * @param {number} [options.maxSections=4]     - max sections to return (including core)
   * @param {string} [options.memoryContext='']   - pre-built memory context string
   * @returns {{ systemPrompt: string, tools: Array, allToolNames: string[] }}
   */
  async assemble(userMessage, options = {}) {
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

    // Core tools first
    for (const name of CORE_TOOLS) {
      if (this._tools.has(name)) {
        selectedTools.push(this._tools.get(name).definition);
        selectedToolNames.add(name);
      }
    }

    // Always include RequestTools escape hatch if registered
    if (this._tools.has('RequestTools')) {
      selectedTools.push(this._tools.get('RequestTools').definition);
      selectedToolNames.add('RequestTools');
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
   * Retrieve specific tools by name (used by the RequestTools escape hatch).
   * @param {string[]} toolNames
   * @returns {Array} tool definitions
   */
  getToolsByName(toolNames = []) {
    return toolNames
      .map(name => this._tools.get(name)?.definition)
      .filter(Boolean);
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

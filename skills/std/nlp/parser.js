/**
 * Natural Language Parser for STD tasks
 * Uses LLM to parse natural language and extract structured tasks
 */

class NLPParser {
  constructor(llmProvider, contextDb) {
    this.llmProvider = llmProvider;
    this.contextDb = contextDb;
  }

  /**
   * Parse natural language into structured tasks
   */
  async parseToTasks(naturalLanguage) {
    // Get context for RAG
    const context = this.contextDb.getContextForRAG();

    // Build prompt for LLM
    const prompt = this._buildPrompt(naturalLanguage, context);

    // Call LLM
    const response = await this._callLLM(prompt);

    // Parse response
    const tasks = this._parseResponse(response);

    return tasks;
  }

  /**
   * Build prompt for LLM
   */
  _buildPrompt(naturalLanguage, context) {
    return `You are a task extraction assistant. Given natural language input and context information, extract discrete tasks.

${context.summary}

User input: "${naturalLanguage}"

Extract tasks from this input. For each task:
1. Create a clear, actionable title
2. Add relevant details based on context
3. Identify any person or project references
4. Suggest appropriate priority (low, medium, high, critical)
5. Suggest tags

Output ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "tasks": [
    {
      "title": "task title",
      "details": "detailed description with context",
      "priority": "medium",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- Split compound statements into separate tasks
- Expand abbreviated references (e.g., "scott's site" -> "Update login for Scott's website")
- Use context to add relevant details
- Be specific and actionable
- Output ONLY the JSON, nothing else`;
  }

  /**
   * Call LLM provider
   */
  async _callLLM(prompt) {
    if (!this.llmProvider) {
      throw new Error('LLM provider not available');
    }

    try {
      // Create a simple message for the LLM
      const messages = [
        {
          role: 'user',
          content: prompt
        }
      ];

      // Call LLM (using King Louie's provider interface)
      const response = await this.llmProvider.sendMessage(messages, {
        temperature: 0.3, // Lower temperature for more consistent output
        max_tokens: 1000
      });

      return response.content || '';
    } catch (error) {
      console.error('[nlp-parser] LLM call failed:', error);
      throw new Error(`Failed to parse natural language: ${error.message}`);
    }
  }

  /**
   * Parse LLM response into task objects
   */
  _parseResponse(response) {
    try {
      // Clean up response - remove markdown code blocks if present
      let cleaned = response.trim();

      // Remove markdown code blocks
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '');
      }

      // Parse JSON
      const parsed = JSON.parse(cleaned);

      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('Invalid response format - missing tasks array');
      }

      // Validate and normalize tasks
      return parsed.tasks.map((task) => ({
        title: task.title || 'Untitled task',
        details: task.details || null,
        priority: this._normalizePriority(task.priority),
        tags: Array.isArray(task.tags) ? task.tags : [],
        status: 'pending'
      }));
    } catch (error) {
      console.error('[nlp-parser] Failed to parse response:', error);
      console.error('[nlp-parser] Response was:', response);
      throw new Error('Failed to parse LLM response. The model may have returned invalid JSON.');
    }
  }

  /**
   * Normalize priority value
   */
  _normalizePriority(priority) {
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    const normalized = String(priority || 'medium').toLowerCase();
    return validPriorities.includes(normalized) ? normalized : 'medium';
  }
}

module.exports = NLPParser;

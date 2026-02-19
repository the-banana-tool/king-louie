/**
 * Natural Language Parser for STD tasks
 * Uses LLM to parse natural language and extract structured tasks
 */

const { parseDate } = require('../utils/parser');

class NLPParser {
  constructor(llmProvider, contextDb, nlpModel = null) {
    this.llmProvider = llmProvider;
    this.contextDb = contextDb;
    this.nlpModel = nlpModel;
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
    const today = new Date().toISOString().split('T')[0];

    return `You are a task extraction assistant. Given natural language input and context information, extract discrete tasks.

Today's date is: ${today}

${context.summary}

User input: "${naturalLanguage}"

Extract tasks from this input. For each task provide:
1. title - clear, actionable task title
2. details - description or additional context (null if none)
3. client - the client, company, or person this task is for (null if not mentioned)
4. dueDate - due date as ISO 8601 string (YYYY-MM-DD), resolving relative dates using today's date (null if not mentioned)
5. priority - low, medium, high, or critical
6. tags - relevant tags

Output ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "tasks": [
    {
      "title": "task title",
      "details": "detailed description with context",
      "client": "Acme Corp",
      "dueDate": "2026-03-15",
      "priority": "medium",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- Split compound statements into separate tasks
- Expand abbreviated references (e.g., "scott's site" -> "Update login for Scott's website")
- Use context to identify clients — people with role "Client" are likely the client for their tasks
- Resolve relative dates (e.g., "next Friday", "end of month", "in 2 weeks") to absolute ISO dates using today's date
- Set client to null if no client is mentioned
- Set dueDate to null if no due date is mentioned
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
        max_tokens: 1000,
        ...(this.nlpModel ? { model: this.nlpModel } : {})
      });

      // Provider responses can be plain strings or objects with `content`
      if (typeof response === 'string') {
        return response;
      }

      if (response && typeof response.content === 'string') {
        return response.content;
      }

      return String(response || '');
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

      // Parse JSON (with fallback extraction if model wraps JSON in extra text)
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON object found in LLM response');
        }
        parsed = JSON.parse(jsonMatch[0]);
      }

      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('Invalid response format - missing tasks array');
      }

      // Validate and normalize tasks
      return parsed.tasks.map((task) => ({
        title: task.title || 'Untitled task',
        details: task.details || null,
        client: task.client || null,
        dueDate: parseDate(task.dueDate) || null,
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

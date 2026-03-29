'use strict';

/**
 * Smart routing engine — evaluates user-defined rules to dynamically
 * select a provider+model based on message content.
 */

function matchCondition(message, condition, context = {}) {
  if (!condition || !condition.type) return false;

  // Agent-mode-only filter
  if (condition.agentModeOnly && !context.agentMode) return false;

  const type = String(condition.type).toLowerCase();

  if (type === 'keyword') {
    const keywords = Array.isArray(condition.keywords) ? condition.keywords : [];
    if (keywords.length === 0) return false;
    const lowerMessage = message.toLowerCase();
    return keywords.some((kw) => {
      const term = String(kw || '').toLowerCase().trim();
      return term.length > 0 && lowerMessage.includes(term);
    });
  }

  if (type === 'regex') {
    const pattern = String(condition.pattern || '');
    if (!pattern) return false;
    try {
      const flags = String(condition.flags || 'i');
      const re = new RegExp(pattern, flags);
      return re.test(message);
    } catch {
      // Invalid regex — treat as no match
      return false;
    }
  }

  if (type === 'prefix') {
    const prefix = String(condition.prefix || '').trim();
    if (!prefix) return false;
    const trimmed = message.trimStart();
    return trimmed.toLowerCase().startsWith(prefix.toLowerCase());
  }

  return false;
}

function evaluateRules(message, rules, context = {}) {
  if (!message || !Array.isArray(rules) || rules.length === 0) return null;

  // Filter to enabled rules, sort by priority (lower first)
  const active = rules
    .filter((r) => r && r.enabled !== false)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  for (const rule of active) {
    if (!rule.condition || !rule.target) continue;
    if (matchCondition(message, rule.condition, context)) {
      return {
        target: rule.target,
        matchedRule: rule
      };
    }
  }

  return null;
}

function stripPrefix(message, prefix) {
  if (!message || !prefix) return message;
  const trimmed = message.trimStart();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed.slice(prefix.length).trimStart();
  }
  return message;
}

function validateRule(rule) {
  const errors = [];

  if (!rule || typeof rule !== 'object') {
    return { valid: false, errors: ['Rule must be an object.'] };
  }

  if (!rule.name || typeof rule.name !== 'string' || !rule.name.trim()) {
    errors.push('Rule must have a non-empty name.');
  }

  if (rule.priority !== undefined && (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority))) {
    errors.push('Priority must be a finite number.');
  }

  // Validate condition
  const cond = rule.condition;
  if (!cond || typeof cond !== 'object') {
    errors.push('Rule must have a condition object.');
  } else {
    const type = String(cond.type || '').toLowerCase();
    if (!['keyword', 'regex', 'prefix'].includes(type)) {
      errors.push('Condition type must be "keyword", "regex", or "prefix".');
    } else if (type === 'keyword') {
      if (!Array.isArray(cond.keywords) || cond.keywords.length === 0) {
        errors.push('Keyword condition requires a non-empty keywords array.');
      }
    } else if (type === 'regex') {
      if (!cond.pattern || typeof cond.pattern !== 'string') {
        errors.push('Regex condition requires a pattern string.');
      } else {
        try {
          new RegExp(cond.pattern, cond.flags || 'i');
        } catch {
          errors.push('Regex pattern is invalid.');
        }
      }
    } else if (type === 'prefix') {
      if (!cond.prefix || typeof cond.prefix !== 'string' || !cond.prefix.trim()) {
        errors.push('Prefix condition requires a non-empty prefix string.');
      }
    }
  }

  // Validate target
  const target = rule.target;
  if (!target || typeof target !== 'object') {
    errors.push('Rule must have a target object.');
  } else {
    if (!target.provider || typeof target.provider !== 'string') {
      errors.push('Target must have a provider string.');
    }
    if (!target.model || typeof target.model !== 'string') {
      errors.push('Target must have a model string.');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  matchCondition,
  evaluateRules,
  stripPrefix,
  validateRule
};

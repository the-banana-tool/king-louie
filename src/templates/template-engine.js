const fs = require('fs');
const path = require('path');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class TemplateEngine {
  constructor(options = {}) {
    this.templatesDirectory = options.templatesDirectory || path.join(process.cwd(), 'templates');
  }

  render(templateContent = '', context = {}, options = {}) {
    const source = String(templateContent || '');
    const includeDirectory = options.includeDirectory || this.templatesDirectory;
    const includeStack = Array.isArray(options.includeStack) ? [...options.includeStack] : [];

    const withIncludes = source.replace(/\{\{>\s*([\w./-]+)\s*\}\}/g, (_match, partialName) => {
      const partialPath = this.resolvePartialPath(partialName, includeDirectory);
      const realPath = fs.realpathSync(partialPath);

      this.assertWithinTemplatesDirectory(realPath);

      if (includeStack.includes(realPath)) {
        throw new Error(`Template include cycle detected: ${[...includeStack, realPath].join(' -> ')}`);
      }

      const partialContent = fs.readFileSync(realPath, 'utf8');
      return this.render(partialContent, context, {
        includeDirectory,
        includeStack: [...includeStack, realPath]
      });
    });

    return withIncludes.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, variablePath) => {
      const resolved = this.getValue(context, variablePath);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }

  renderFile(templatePath, context = {}) {
    const absoluteTemplatePath = path.isAbsolute(templatePath)
      ? templatePath
      : path.resolve(process.cwd(), templatePath);
    const content = fs.readFileSync(absoluteTemplatePath, 'utf8');
    return this.render(content, context, {
      includeDirectory: path.dirname(absoluteTemplatePath),
      includeStack: [path.normalize(absoluteTemplatePath)]
    });
  }

  resolvePartialPath(partialName, includeDirectory) {
    const baseName = String(partialName || '').trim();
    const candidates = [
      path.resolve(includeDirectory, `${baseName}.md.template`),
      path.resolve(includeDirectory, baseName),
      path.resolve(this.templatesDirectory, `${baseName}.md.template`),
      path.resolve(this.templatesDirectory, baseName),
      path.resolve(this.templatesDirectory, 'partials', `${baseName}.md.template`),
      path.resolve(this.templatesDirectory, 'partials', baseName)
    ];

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new Error(`Unable to resolve template partial: ${baseName}`);
    }

    return found;
  }

  assertWithinTemplatesDirectory(resolvedPath) {
    const realTemplatesDir = fs.realpathSync(this.templatesDirectory);
    const normalized = path.resolve(resolvedPath);
    if (!normalized.startsWith(realTemplatesDir + path.sep) && normalized !== realTemplatesDir) {
      throw new Error(`Template path escapes templates directory: ${resolvedPath}`);
    }
  }

  getValue(context, variablePath) {
    const keys = String(variablePath || '').split('.').filter(Boolean);
    let current = context;

    for (const key of keys) {
      if (current == null || typeof current !== 'object') {
        return undefined;
      }
      if (UNSAFE_KEYS.has(key)) {
        return undefined;
      }
      current = current[key];
    }

    return current;
  }
}

module.exports = TemplateEngine;
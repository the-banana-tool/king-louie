const { parseArgs } = require('../utils/parser');
const { formatSuccess } = require('../utils/formatter');

/**
 * Manage context (people, projects) for RAG
 * Usage:
 *   /std context add person "Scott" --role "Client" --notes "Website owner"
 *   /std context add project "Scott's Site" --description "E-commerce website"
 *   /std context list people
 *   /std context list projects
 */
async function contextCommand(args, database, context) {
  const parsed = parseArgs(args);

  if (parsed.positional.length === 0) {
    return {
      ok: false,
      error: 'Subcommand required. Usage: /std context add|list <type> ...'
    };
  }

  const subcommand = parsed.positional[0].toLowerCase();
  const contextDb = context.contextDb;

  if (!contextDb) {
    return {
      ok: false,
      error: 'Context database not available'
    };
  }

  // ADD command
  if (subcommand === 'add') {
    if (parsed.positional.length < 3) {
      return {
        ok: false,
        error: 'Usage: /std context add <person|project> "Name" [options]'
      };
    }

    const type = parsed.positional[1].toLowerCase();
    const name = parsed.positional[2];

    if (type === 'person') {
      const aliases = parsed.flags.aliases
        ? parsed.flags.aliases.split(',').map((a) => a.trim())
        : [];

      contextDb.addPerson({
        name,
        aliases,
        role: parsed.flags.role || null,
        email: parsed.flags.email || null,
        notes: parsed.flags.notes || null
      });

      return {
        ok: true,
        message: formatSuccess(`Added person: ${name}`)
      };
    }

    if (type === 'project') {
      contextDb.addProject({
        name,
        description: parsed.flags.description || null,
        owner: parsed.flags.owner || null,
        status: parsed.flags.status || 'active',
        tags: parsed.flags.tags ? parsed.flags.tags.split(',').map((t) => t.trim()) : []
      });

      return {
        ok: true,
        message: formatSuccess(`Added project: ${name}`)
      };
    }

    return {
      ok: false,
      error: 'Unknown type. Use: person or project'
    };
  }

  // LIST command
  if (subcommand === 'list') {
    if (parsed.positional.length < 2) {
      return {
        ok: false,
        error: 'Usage: /std context list <people|projects>'
      };
    }

    const type = parsed.positional[1].toLowerCase();

    if (type === 'people' || type === 'person') {
      const people = contextDb.getAllPeople();

      if (people.length === 0) {
        return {
          ok: true,
          message: 'No people in context database. Add with: /std context add person "Name" --role "Role"'
        };
      }

      const lines = ['👥 People:', ''];
      for (const person of people) {
        const aliases = person.aliases.length > 0 ? ` (aka ${person.aliases.join(', ')})` : '';
        lines.push(`**${person.name}**${aliases}`);
        if (person.role) lines.push(`  Role: ${person.role}`);
        if (person.email) lines.push(`  Email: ${person.email}`);
        if (person.notes) lines.push(`  Notes: ${person.notes}`);
        lines.push('');
      }

      return {
        ok: true,
        message: lines.join('\n')
      };
    }

    if (type === 'projects' || type === 'project') {
      const projects = contextDb.getAllProjects();

      if (projects.length === 0) {
        return {
          ok: true,
          message: 'No projects in context database. Add with: /std context add project "Name" --description "..."'
        };
      }

      const lines = ['📁 Projects:', ''];
      for (const project of projects) {
        lines.push(`**${project.name}**`);
        if (project.description) lines.push(`  ${project.description}`);
        if (project.owner) lines.push(`  Owner: ${project.owner}`);
        if (project.status) lines.push(`  Status: ${project.status}`);
        if (project.tags.length > 0) lines.push(`  Tags: ${project.tags.join(', ')}`);
        lines.push('');
      }

      return {
        ok: true,
        message: lines.join('\n')
      };
    }

    return {
      ok: false,
      error: 'Unknown type. Use: people or projects'
    };
  }

  return {
    ok: false,
    error: 'Unknown subcommand. Use: add or list'
  };
}

module.exports = contextCommand;

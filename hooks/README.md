# King Louie Hooks

Hooks let you run custom logic around key lifecycle events:

- `PreToolUse`
- `PostToolUse`
- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`

## Structure

Each hook lives in its own directory under `hooks/` and must include a `hook.json` file.

Example:

```text
hooks/
  my-hook/
    hook.json
    index.js
```

## `hook.json` shape

```json
{
  "name": "my-hook",
  "event": "PreToolUse",
  "matcher": "Bash",
  "enabled": true,
  "description": "Optional description",
  "handler": "index.js"
}
```

- `matcher` supports `*` wildcards (for tool names)
- `handler` can be:
  - a JS file path relative to the hook folder
  - an absolute JS file path
  - an inline shell handler with `shell:<command>`

## Handler contract

JS handlers receive a single `context` object and can return:

- `{ action: "allow" }`
- `{ action: "deny", message: "..." }`
- `{ action: "confirm", message: "..." }`
- `{ action: "modify", parameters: { ... } }`

For `PostToolUse`, handlers can optionally return `{ context: { result: ... } }` to override the tool result.

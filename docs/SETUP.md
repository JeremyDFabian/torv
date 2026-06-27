# torv MCP server — setup guide

torv exposes `verify_dependency` as an MCP tool over stdio. Registering the server
in your agent client means the agent will be able to call the tool before any
package install.

---

## Prerequisites

- Node.js 18 or later
- The repo cloned and dependencies installed:

  ```
  npm install
  npm run build
  ```

  The build output lands in `dist/`. The MCP entry point is `dist/mcp/server.js`.

---

## Running the server (smoke-test)

```
node dist/mcp/server.js
```

The server speaks JSON-RPC over stdio. You should see no output — it is waiting
for a client. Press Ctrl-C to exit.

To confirm the tool is registered, you can pipe a raw `tools/list` request:

```
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dist/mcp/server.js
```

Expected: a JSON response listing `verify_dependency`.

---

## Claude Code

### Project-scoped (recommended)

Add a `.mcp.json` file at the repo root. Claude Code discovers this automatically
when you open the project.

```json
{
  "mcpServers": {
    "torv": {
      "command": "node",
      "args": ["dist/mcp/server.js"]
    }
  }
}
```

> The path `dist/mcp/server.js` is relative to the directory where Claude Code is
> launched. If you launch from a different directory, use an absolute path:
> `"/path/to/torv/dist/mcp/server.js"`.

After adding the file, restart Claude Code (or run `/mcp` to reload servers).

### User-scoped (applies across all projects)

Edit `~/.claude/settings.json` and merge in:

```json
{
  "mcpServers": {
    "torv": {
      "command": "node",
      "args": ["/absolute/path/to/torv/dist/mcp/server.js"]
    }
  }
}
```

---

## Cursor

Open **Settings → MCP** (or edit `~/.cursor/mcp.json`) and add:

```json
{
  "mcpServers": {
    "torv": {
      "command": "node",
      "args": ["/absolute/path/to/torv/dist/mcp/server.js"]
    }
  }
}
```

For a project-scoped configuration, create `.cursor/mcp.json` at the repo root
with the same structure (relative paths work when Cursor is opened from the repo
root).

---

## Adding the client rules

Once the server is registered, copy the behavioral rules from
[`docs/mcp-client-rules.jsonc`](./mcp-client-rules.jsonc) into your agent's
rules or system-prompt configuration so it knows to call `verify_dependency`
before any install.

**Claude Code** — paste the `rules[].description` text into your project's
`CLAUDE.md`, or into a `.claude/project-instructions.md` file:

```markdown
Before running npm install, pip install, or any equivalent command, call the
verify_dependency MCP tool for each new package. Do not proceed with an install
until a verdict is returned. Block on red; ask for confirmation on yellow.
```

**Cursor** — add the same text to `.cursor/rules` (one rule per file, plain
Markdown) or to the "Rules for AI" field in Cursor's settings UI.

---

## Verdict reference

| Tier   | Meaning                                              | Recommended action          |
|--------|------------------------------------------------------|-----------------------------|
| green  | Registry confirms the package exists, looks legitimate | Proceed with install        |
| yellow | Low confidence or missing data (fail-closed default) | Ask user for confirmation   |
| red    | Strong hallucination or slopsquatting signal         | Block; explain and suggest alternatives |

---

## Updating after a rebuild

The server reads `dist/mcp/server.js` at startup — no MCP config change is
needed after `npm run build`. Just restart the agent or reconnect the MCP client.

# @klura/agent-claude-code

Claude provider for the [klura](https://www.npmjs.com/package/@klura/runtime) CLI agent (`klura chat`, `klura execute --agent`).

Drives klura with the Claude Agent SDK — the engine behind Claude Code. Reuses your existing Claude Code authentication, so there is no separate API key to manage.

## Install

```bash
npm install -g @klura/agent-claude-code
```

Then point klura at it:

```bash
klura chat --provider claude-code
```

Or set it in `~/.klura/config.json`:

```jsonc
{
  "agent": {
    "provider": "claude-code",
    "model": "claude-sonnet-4-6"
  }
}
```

## License

BUSL-1.1

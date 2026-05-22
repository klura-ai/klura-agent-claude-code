'use strict';

// Claude provider for @klura/agent — drives klura with the Claude Agent SDK
// (the engine behind Claude Code). Reuses the user's existing Claude Code
// credentials; no separate API key needed.
//
// The SDK consumes the klura MCP server instance directly (`{type:'sdk',
// instance}`), so the in-process browser pool survives across `resume`
// queries. Each `sdk.query()` runs until a terminal `result`; the outer loop
// spawns a fresh `query({resume})` only when the agent ended a turn with text
// and `onTurnEnd` returned a continuation.

const path = require('path');

async function loadAgentSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    throw new Error(
      'agent-claude-code: cannot load @anthropic-ai/claude-agent-sdk. ' +
        'Install it with: npm install -g @klura/agent-claude-code',
      { cause: err },
    );
  }
}

function loadAgentCore() {
  try {
    return require('@klura/runtime/agent');
  } catch {
    return require(path.join(__dirname, '..', 'runtime', 'agent'));
  }
}

// Parse one tool_result content block into {result, obligationText}, mirroring
// what the SDK delivers and what klura's formatToolResult emits.
function parseToolResult(content, unwrapPersistedOutput) {
  let result = content;
  let obligationText = null;
  if (typeof result === 'string') {
    const unwrapped = unwrapPersistedOutput(result);
    if (unwrapped !== null) {
      try {
        result = JSON.parse(unwrapped);
      } catch {
        result = unwrapped;
      }
    }
  }
  if (Array.isArray(result)) {
    const obligationBlock = result.find(
      (c) => c.type === 'text' && c.text.startsWith('[klura obligation]:'),
    );
    if (obligationBlock) obligationText = obligationBlock.text;
    const payloadBlock =
      result.find((c) => c.type === 'text' && c.text.startsWith('[Tool result for ')) ||
      result.find((c) => c.type === 'text' && c !== obligationBlock) ||
      result.find((c) => c.type === 'text');
    if (payloadBlock) {
      let forParse = payloadBlock.text.replace(/^\[.*?\]:\n/, '');
      const unwrapped = unwrapPersistedOutput(forParse);
      if (unwrapped !== null) forParse = unwrapped;
      try {
        result = JSON.parse(forParse);
      } catch {
        result = forParse;
      }
    }
  }
  return { result, obligationText };
}

function createProvider(config = {}) {
  return {
    id: 'claude-code',
    label: 'Claude Agent SDK',
    defaultModel: 'claude-sonnet-4-6',

    async runAgent(opts) {
      const sdk = await loadAgentSdk();
      const { unwrapPersistedOutput } = loadAgentCore();
      const model = opts.model || config.model || 'claude-sonnet-4-6';
      const maxTurns = opts.maxRounds || 40;
      const emit = opts.emit || (() => {});

      const steps = [];
      let sdkTurn = 0;
      let finalMessage = '';
      let terminationReason = null;
      let sdkResult = null;

      const baseOptions = {
        systemPrompt: opts.systemPrompt,
        model,
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: ['mcp__klura__*', 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
        disallowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'TodoRead',
          'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit', 'LSP', 'Skill',
          'AskFollowupQuestion', 'AskUserQuestion', 'ToolSearch',
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: {
          klura: { type: 'sdk', name: 'klura', instance: opts.server },
        },
      };

      // Drain one sdk.query() stream to its terminal `result`.
      async function runSingleQuery(promptInput, resumeSessionId) {
        const queryOptions = { ...baseOptions, maxTurns: Math.max(1, maxTurns - sdkTurn) };
        if (resumeSessionId) queryOptions.resume = resumeSessionId;
        const q = sdk.query({ prompt: promptInput, options: queryOptions });

        let lastAssistantText = null;
        let lastAssistantHadToolUse = false;
        let localResult = null;
        let crash = null;
        try {
          for await (const msg of q) {
            if (msg.type === 'result') {
              localResult = msg;
              continue;
            }
            if (msg.type === 'assistant' && msg.message?.content) {
              sdkTurn++;
              lastAssistantText = null;
              lastAssistantHadToolUse = false;
              for (const block of msg.message.content) {
                if (block.type === 'text' && block.text?.trim()) {
                  const text = block.text.trim();
                  steps.push({ type: 'text', content: text });
                  emit({ type: 'text', text });
                  lastAssistantText = text;
                }
                if (block.type === 'tool_use') {
                  lastAssistantHadToolUse = true;
                  const toolName = block.name.replace(/^mcp__klura__/, '');
                  steps.push({ type: 'tool_call', tool: toolName, args: block.input || {}, toolUseId: block.id });
                  emit({ type: 'tool_call', tool: toolName, args: block.input || {} });
                }
              }
            }
            if (msg.type === 'user' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type !== 'tool_result') continue;
                const call = steps.findLast(
                  (s) => s.type === 'tool_call' && s.toolUseId === block.tool_use_id,
                );
                const toolName = call?.tool ?? 'unknown';
                const { result, obligationText } = parseToolResult(block.content, unwrapPersistedOutput);
                steps.push({ type: 'tool_result', tool: toolName, result });
                emit({ type: 'tool_result', tool: toolName, result, obligationText });
              }
            }
          }
        } catch (err) {
          crash = err && err.message ? err.message : String(err);
        }
        return {
          sessionId: localResult?.session_id || null,
          subtype: localResult?.subtype || null,
          sdkResult: localResult,
          crash,
          lastAssistantText,
          lastAssistantHadToolUse,
        };
      }

      let nextPrompt = opts.goal;
      let resumeSessionId = null;
      for (;;) {
        const step = await runSingleQuery(nextPrompt, resumeSessionId);
        if (step.sdkResult) sdkResult = step.sdkResult;
        if (step.crash) {
          terminationReason = 'crash';
          break;
        }
        if (step.subtype && step.subtype !== 'success') {
          terminationReason = step.subtype;
          break;
        }
        if (sdkTurn >= maxTurns) {
          terminationReason = 'max_turns';
          break;
        }
        // Turn ended mid-tool or with no text — nothing to hand to onTurnEnd.
        if (!step.lastAssistantText || step.lastAssistantHadToolUse) {
          terminationReason = 'no_text_tail';
          break;
        }
        finalMessage = step.lastAssistantText;
        const reply = await opts.onTurnEnd(step.lastAssistantText, { steps });
        if (reply === null || reply === undefined) {
          terminationReason = 'turn_ended';
          break;
        }
        if (!step.sessionId) {
          terminationReason = 'no_session_to_resume';
          break;
        }
        nextPrompt = String(reply);
        resumeSessionId = step.sessionId;
      }

      return {
        finalMessage,
        steps,
        usage: sdkResult?.usage || null,
        rounds: sdkTurn,
        terminationReason: terminationReason || 'done',
      };
    },
  };
}

module.exports = { createProvider };

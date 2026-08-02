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
//
// Two stop conditions cut a stream short before the model spends another
// round: a terminal tool result the server hands back
// (`takeTerminalToolResult`), and — under `failFastToolErrors` — the first
// tool_result block flagged `is_error`. A stream failure is thrown with
// `partialAgentResult` attached so the caller keeps both the crash reason and
// the work done up to it.

const path = require('path');

/** Shortest gap between generating-turn heartbeats forwarded to the host. */
const PROGRESS_HEARTBEAT_MS = 30_000;

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
      const sdk = await (config.loadAgentSdk || loadAgentSdk)();
      const { unwrapPersistedOutput } = loadAgentCore();
      const model = opts.model || config.model || 'claude-sonnet-4-6';
      const maxTurns = opts.maxRounds || 40;
      const emit = opts.emit || (() => {});
      const failFastToolErrors =
        opts.failFastToolErrors === true || config.failFastToolErrors === true;

      const steps = [];
      let sdkTurn = 0;
      let finalMessage = '';
      let terminationReason = null;
      let sdkResult = null;
      let terminalToolResult = null;

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
        // Partial-message events keep the harness's stall watchdog fed while a
        // turn is still generating. Without them the stream is silent until a
        // message completes, so a long authoring turn is indistinguishable
        // from a dead one and gets killed mid-work.
        includePartialMessages: true,
        mcpServers: {
          klura: { type: 'sdk', name: 'klura', instance: opts.server },
        },
      };

      // Drain one sdk.query() stream to its terminal `result`, or to the first
      // stop condition — whichever comes first.
      async function runSingleQuery(promptInput, resumeSessionId) {
        const queryOptions = { ...baseOptions, maxTurns: Math.max(1, maxTurns - sdkTurn) };
        if (resumeSessionId) queryOptions.resume = resumeSessionId;
        const q = sdk.query({ prompt: promptInput, options: queryOptions });

        let lastAssistantText = null;
        let lastAssistantHadToolUse = false;
        let localResult = null;
        let lastProgressAt = 0;
        for await (const msg of q) {
          // A partial event says the turn is still generating. Forward it as a
          // rate-limited heartbeat so the harness's stall watchdog can tell a
          // long authoring turn from a dead stream, without spamming the
          // transcript with token-level noise.
          if (msg.type === 'stream_event') {
            const nowMs = Date.now();
            if (nowMs - lastProgressAt >= PROGRESS_HEARTBEAT_MS) {
              lastProgressAt = nowMs;
              emit({ type: 'progress', detail: 'generating' });
            }
            continue;
          }
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
                steps.push({
                  type: 'tool_call',
                  tool: toolName,
                  args: block.input || {},
                  toolUseId: block.id,
                });
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
              const { result, obligationText } = parseToolResult(
                block.content,
                unwrapPersistedOutput,
              );
              steps.push({
                type: 'tool_result',
                tool: toolName,
                result,
                toolUseId: block.tool_use_id,
              });
              emit({ type: 'tool_result', tool: toolName, result, obligationText });
              const terminal =
                typeof opts.server?.takeTerminalToolResult === 'function'
                  ? opts.server.takeTerminalToolResult()
                  : null;
              if (terminal) {
                terminalToolResult = terminal;
                break;
              }
              if (failFastToolErrors && block.is_error === true) {
                terminalToolResult = {
                  terminate: true,
                  kind: 'actor_tool_error',
                  code: 'actor_tool_error',
                  source: `tool_result:${toolName}`,
                  tool: toolName,
                  reason: 'mcp_error_result',
                };
                break;
              }
            }
            // Breaking the stream returns the SDK generator, which tears the
            // query down; nothing else is drained after a terminal result.
            if (terminalToolResult) break;
          }
        }
        return {
          sessionId: localResult?.session_id || null,
          subtype: localResult?.subtype || null,
          sdkResult: localResult,
          lastAssistantText,
          lastAssistantHadToolUse,
        };
      }

      let nextPrompt = opts.goal;
      let resumeSessionId = null;
      try {
        for (;;) {
          const step = await runSingleQuery(nextPrompt, resumeSessionId);
          if (step.sdkResult) sdkResult = step.sdkResult;
          if (terminalToolResult) {
            terminationReason =
              typeof terminalToolResult.code === 'string'
                ? terminalToolResult.code
                : 'terminal_tool_result';
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
          const reply = await opts.onTurnEnd(step.lastAssistantText, { steps, rounds: sdkTurn });
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
      } catch (error) {
        // The caller reads the crash reason and its `code` off this error; the
        // partial result carries the work the run already produced.
        if (error && typeof error === 'object') {
          error.partialAgentResult = {
            finalMessage,
            steps,
            usage: sdkResult?.usage || null,
            rounds: sdkTurn,
            terminationReason: 'crash',
            model,
            terminalToolResult,
          };
        }
        throw error;
      }

      return {
        finalMessage,
        steps,
        usage: sdkResult?.usage || null,
        rounds: sdkTurn,
        terminationReason: terminationReason || 'done',
        model,
        terminalToolResult,
      };
    },
  };
}

module.exports = { createProvider };

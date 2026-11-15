# DeepSeek DSML Leak + Tool Safety Hardening Summary

## Problem

With DeepSeek, rare responses leak internal DSML/tool-call markup into visible assistant output, for example:

```xml
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="edit_file">
...
</｜｜DSML｜｜tool_calls>
```

This should never reach the chat UI or be persisted as normal assistant text.

There was also a separate safety issue where an edit appeared to happen after the user denied permission. That must be handled by the runtime, not by trusting the model.

---

## Primary Goal

Prevent internal tool markup from being shown or saved, and ensure file edits/tools cannot execute without fresh explicit approval.

---

## DeepSeek Settings

For DeepSeek tool/edit/run turns, disable thinking and do not send high/max reasoning effort.

Recommended for mutation/tool-loop turns:

```ts
const deepseekOptionsForToolTurns = {
  extra_body: {
    thinking: { type: "disabled" },
  },

  // Do not send reasoning_effort here.
};
```

Do not send:

```ts
reasoning_effort: "high"
reasoning_effort: "max"
```

during file-edit, run-command, apply-patch, or automated tool-loop turns.

Use reasoning only for non-mutating planning/explanation/debug-analysis turns:

```ts
function getDeepSeekOptions(taskType: string) {
  const toolOrMutationTurn =
    taskType === "edit_file" ||
    taskType === "run_command" ||
    taskType === "apply_patch" ||
    taskType === "tool_loop";

  if (toolOrMutationTurn) {
    return {
      extra_body: {
        thinking: { type: "disabled" },
      },
    };
  }

  return {
    reasoning_effort: "high",
    extra_body: {
      thinking: { type: "enabled" },
    },
  };
}
```

Rationale: thinking/high reasoning increases protocol complexity because the runtime must distinguish visible `content`, internal `reasoning_content`, and structured `tool_calls`. That makes rare DSML leaks more likely in streaming/tool-heavy flows.

---

## Prefer Native Tool Calls

Use native provider/API tool calls where possible.

Do not rely on prompt-emitted XML/DSML tool calls unless unavoidable.

The runtime should trust only structured tool calls, for example:

```ts
message.tool_calls
```

not raw text that resembles a tool call.

If DSML support is still required, parse it only in a controlled internal parser, never from visible assistant text.

---

## Add a DSML Leak Detector

Before rendering or saving assistant content, detect internal tool markup.

```ts
const DSML_LEAK_RE =
  /<\s*\/?\s*[｜|]{2}\s*DSML\s*[｜|]{2}\s*(tool_calls|invoke|parameter)\b/i;

export function isLeakedToolMarkup(text: string): boolean {
  return DSML_LEAK_RE.test(text);
}
```

Also strip complete leaked blocks if needed:

```ts
const DSML_TOOL_CALL_BLOCK_RE =
  /<\s*[｜|]{2}\s*DSML\s*[｜|]{2}\s*tool_calls\s*>[\s\S]*?<\s*\/\s*[｜|]{2}\s*DSML\s*[｜|]{2}\s*tool_calls\s*>/gi;

export function stripInternalToolMarkup(text: string): string {
  return text.replace(DSML_TOOL_CALL_BLOCK_RE, "").trim();
}
```

Use a sanitizer:

```ts
export function sanitizeAssistantContent(raw: string): {
  visibleText: string;
  hadInternalLeak: boolean;
} {
  const hadInternalLeak = isLeakedToolMarkup(raw);
  const visibleText = stripInternalToolMarkup(raw);

  return {
    visibleText,
    hadInternalLeak,
  };
}
```

---

## Block Leaked DSML Before UI and Persistence

Before appending assistant output to chat state:

```ts
const sanitized = sanitizeAssistantContent(modelMessage.content ?? "");

if (sanitized.hadInternalLeak) {
  console.warn("Blocked leaked internal tool markup", {
    model,
    conversationId,
    turnId,
  });

  // Do not render or persist the raw model output.
  blockAssistantMessage(turnId);

  // Optional: retry once with thinking disabled and no reasoning_effort.
  retryTurn({
    thinking: { type: "disabled" },
    reasoning_effort: undefined,
  });

  return;
}

appendAssistantMessage(sanitized.visibleText);
```

Hard rule: leaked internal markup must never enter `chatStore.ts` as normal assistant-visible content.

---

## Streaming Guard

Do not append streamed tokens directly to visible chat state.

Bad:

```ts
onToken(token => appendAssistantMessage(token));
```

Better:

```ts
let pending = "";

function handleToken(token: string) {
  pending += token;

  if (isLeakedToolMarkup(pending)) {
    blockAssistantMessage(currentTurnId);
    cancelStream();
    retryTurn({
      thinking: { type: "disabled" },
      reasoning_effort: undefined,
    });
    return;
  }

  // Flush only known-safe visible text.
  flushSafeVisibleText(pending);
}
```

Keep a small lookbehind buffer so partial strings like `<｜｜DSML` are not flushed before detection.

Example:

```ts
const PARTIAL_INTERNAL_PREFIXES = [
  "<｜",
  "<|",
  "<｜｜",
  "<||",
  "<｜｜DSML",
  "<||DSML",
];

function mightBecomeInternalMarkup(tail: string): boolean {
  return PARTIAL_INTERNAL_PREFIXES.some(prefix =>
    tail.endsWith(prefix) || prefix.startsWith(tail)
  );
}
```

---

## Retry Policy

On DSML leak:

1. Cancel the current assistant turn.
2. Do not save leaked content.
3. Retry once with:

   * thinking disabled
   * no reasoning effort parameter
   * low temperature
   * instruction not to emit DSML/tool markup as text
4. If it leaks again, stop and show a safe error.

Example retry message:

```ts
{
  role: "user",
  content:
    "Your previous response emitted internal tool markup as visible text. Do not print DSML/XML/tool markup. Use only native structured tool calls or normal user-visible text."
}
```

---

## File Edit Permission Hardening

The model must never be trusted to enforce edit permission.

All mutation tools must require fresh runtime approval.

Mutation tools include:

```ts
const MUTATION_TOOLS = new Set([
  "edit_file",
  "write_file",
  "delete_file",
  "move_file",
  "run",
  "apply_patch",
]);
```

Use per-tool-call approval, not global approval.

```ts
type ToolApproval = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  argsHash: string;
  approved: boolean;
  expiresAt: number;
};
```

Validate approval at execution time:

```ts
function isApprovalValidForToolCall(
  toolCall: ToolCall,
  approval: ToolApproval
): boolean {
  return (
    approval.approved === true &&
    approval.toolCallId === toolCall.id &&
    approval.toolName === toolCall.name &&
    approval.argsHash === hashArgs(toolCall.args) &&
    Date.now() < approval.expiresAt
  );
}
```

Guard execution:

```ts
async function executeToolCall(toolCall: ToolCall, ctx: ToolContext) {
  if (MUTATION_TOOLS.has(toolCall.name)) {
    const approval = await approvalStore.requireFreshApproval(toolCall);

    if (!approval.approved) {
      auditLog("tool_denied", toolCall);

      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: "Denied by user. The action was not executed.",
      };
    }

    if (!isApprovalValidForToolCall(toolCall, approval)) {
      throw new Error("Invalid or stale approval token");
    }
  }

  return runTool(toolCall, ctx);
}
```

Also check inside the tool itself:

```ts
async function editFile(args: EditFileArgs, ctx: ToolContext) {
  if (!ctx.approval?.approved) {
    throw new Error("edit_file requires explicit user approval");
  }

  if (ctx.approval.toolCallId !== ctx.toolCallId) {
    throw new Error("approval does not match tool call");
  }

  return actuallyEditFile(args);
}
```

This ensures that even if the agent loop has a bug, the file-editing tool refuses to run without valid approval.

---

## Denial Handling

If the user denies an edit:

```ts
if (userDenied) {
  pendingToolCalls.delete(toolCallId);
  markToolCallDenied(toolCallId);
  blockAllToolCallsFromTurn(turnId);
  cancelAssistantTurn(turnId);

  return {
    role: "tool",
    tool_call_id: toolCallId,
    content:
      "Denied by user. Do not retry this action unless the user explicitly asks again.",
  };
}
```

Important: denial must invalidate the staged call and all other mutation calls from the same assistant turn.

---

## Logging

Log every mutation attempt with:

```ts
{
  model,
  conversationId,
  turnId,
  toolCallId,
  toolName,
  argsHash,
  approvalId,
  userDecision,
  executed,
  timestamp
}
```

For DSML leaks, log:

```ts
{
  model,
  conversationId,
  turnId,
  leakedMarkupDetected: true,
  rawOutputRedactedOrStoredPrivately,
  retried,
  timestamp
}
```

Do not render raw leaked DSML to the user.

---

## Final Implementation Checklist

1. Disable DeepSeek thinking for tool/edit/run turns.
2. Do not send `reasoning_effort: "high"` or `"max"` for mutation/tool-loop turns.
3. Prefer native structured tool calls over prompt-based DSML.
4. Add DSML leak detection before rendering.
5. Add DSML leak detection before persistence.
6. Add streaming guard with lookbehind buffering.
7. On leak, cancel the turn and retry once with safer settings.
8. Require fresh per-call approval for mutation tools.
9. Validate approval in both the tool dispatcher and the mutation tool itself.
10. On denial, invalidate pending calls and block all mutation calls from that assistant turn.
11. Add audit logs for leaks, approvals, denials, and executions.
12. Never let raw internal tool markup enter chat state as normal assistant content.


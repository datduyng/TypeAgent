# @typeagent/agent-harness-hooks

Types for agent harness command hooks: the JSON payload a hook reads on stdin
and the JSON output it can write on stdout.

Copilot CLI hooks:

| Hook                  | Input                      | Output                      |
| --------------------- | -------------------------- | --------------------------- |
| `userPromptSubmitted` | `UserPromptSubmittedInput` | `UserPromptSubmittedOutput` |
| `sessionStart`        | `SessionStartInput`        | `SessionStartOutput`        |
| `agentStop`           | `AgentStopInput`           | `AgentStopOutput`           |

```ts
import type { UserPromptSubmittedInput } from "@typeagent/agent-harness-hooks";
```

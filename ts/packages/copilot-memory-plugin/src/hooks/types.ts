// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
    AgentStopInput,
    UserPromptSubmittedInput,
    UserPromptTransformedInput,
    UserPromptTransformedOutput,
} from "@typeagent/agent-harness-hooks";

// One router handles both prompt hooks; transformedPrompt marks the second.
export type PromptHookInput =
    | UserPromptSubmittedInput
    | UserPromptTransformedInput;

// Non-Copilot hosts may also send the response text and knowledge.
export type StopHookInput = AgentStopInput & {
    response?: string;
    knowledge?: unknown;
};

export type HookOutput = UserPromptTransformedOutput;

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Copilot CLI command-hook payloads (stdin) and supported outputs (stdout).
 *
 * Shapes match the JSON Copilot CLI 1.0.91 writes to command hooks. This
 * differs from the SDK callback types: `timestamp` is epoch ms (not Date),
 * `cwd` (not workingDirectory), and `stop_hook_active` is snake_case.
 *
 *   userPromptSubmitted  ->  sessionStart (first prompt)  ->  ...tools...  ->  agentStop
 *   { prompt }               { source, initialPrompt }                        { stopReason }
 *
 * Notes from captured sessions:
 * - userPromptSubmitted also fires for prompts delegated to sub-agents,
 *   with the child sessionId.
 * - There is no native "agentStart"; sessionStart is the start hook.
 * - agentStop fires for the root and for each sub-agent.
 */

/** Fields present on every hook payload. */
export type BaseHookInput = {
    sessionId: string;
    /** Epoch milliseconds. */
    timestamp: number;
    cwd: string;
};

/** userPromptSubmitted input. */
export type UserPromptSubmittedInput = BaseHookInput & {
    prompt: string;
};

/**
 * userPromptSubmitted output. Set `handled` with `responseContent` to answer
 * without a model call.
 */
export type UserPromptSubmittedOutput = {
    modifiedPrompt?: string;
    additionalContext?: string;
    suppressOutput?: boolean;
    handled?: boolean;
    responseContent?: string;
    handledBy?: string;
};

/** sessionStart input. */
export type SessionStartInput = BaseHookInput & {
    source: "startup" | "resume" | "new";
    initialPrompt?: string;
};

/** sessionStart output. `additionalContext` is injected into the conversation. */
export type SessionStartOutput = {
    additionalContext?: string;
};

/** agentStop input. */
export type AgentStopInput = BaseHookInput & {
    /** Example: "end_turn". */
    stopReason?: string;
    transcriptPath?: string;
    /** True when this stop follows an earlier `decision: "block"`. */
    stop_hook_active?: boolean;
};

/**
 * agentStop output. `{ decision: "block", reason }` keeps the agent running
 * with `reason` as the next user message. The CLI caps consecutive blocks at 8.
 */
export type AgentStopOutput = {
    decision?: "block";
    reason?: string;
};

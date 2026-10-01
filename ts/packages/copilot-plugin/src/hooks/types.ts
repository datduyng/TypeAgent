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
export interface BaseHookInput {
    sessionId: string;
    /** Epoch milliseconds. */
    timestamp: number;
    cwd: string;
}

/** userPromptSubmitted input. */
export interface UserPromptSubmittedInput extends BaseHookInput {
    prompt: string;
}

/**
 * userPromptSubmitted output. Set `handled` with `responseContent` to answer
 * without a model call.
 */
export interface UserPromptSubmittedOutput {
    modifiedPrompt?: string;
    additionalContext?: string;
    suppressOutput?: boolean;
    handled?: boolean;
    responseContent?: string;
    handledBy?: string;
}

/** sessionStart input. */
export interface SessionStartInput extends BaseHookInput {
    source: "startup" | "resume" | "new";
    initialPrompt?: string;
}

/** sessionStart output. `additionalContext` is injected into the conversation. */
export interface SessionStartOutput {
    additionalContext?: string;
}

/** agentStop input. */
export interface AgentStopInput extends BaseHookInput {
    /** Example: "end_turn". */
    stopReason?: string;
    transcriptPath?: string;
    /** True when this stop follows an earlier `decision: "block"`. */
    stop_hook_active?: boolean;
}

/**
 * agentStop output. `{ decision: "block", reason }` keeps the agent running
 * with `reason` as the next user message. The CLI caps consecutive blocks at 8.
 */
export interface AgentStopOutput {
    decision?: "block";
    reason?: string;
}

/** Existing names for the userPromptSubmitted hook. */
export type HookInput = UserPromptSubmittedInput;
export type HookOutput = UserPromptSubmittedOutput;

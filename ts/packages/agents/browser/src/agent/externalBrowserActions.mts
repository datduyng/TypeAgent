// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ActionResult } from "@typeagent/agent-sdk";
import { createActionResultFromError } from "@typeagent/agent-sdk/helpers/action";
import type { BrowserControl } from "@typeagent/browser-control-rpc/types";
import type { CloseWindow } from "./externalBrowserActionSchema.mjs";

export async function executeCloseWindow(
    action: CloseWindow,
    getControl: () => Pick<BrowserControl, "closeWindow">,
): Promise<ActionResult | undefined> {
    if (action.parameters.title !== undefined) {
        return createActionResultFromError(
            "Closing a browser window by title is not supported. The current window was left open.",
        );
    }

    await getControl().closeWindow();
    return undefined;
}

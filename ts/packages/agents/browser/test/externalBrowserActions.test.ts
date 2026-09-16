// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { executeCloseWindow } from "../src/agent/externalBrowserActions.mjs";

describe("executeCloseWindow", () => {
    test("rejects a named target without resolving browser control", async () => {
        const getControl = jest.fn(() => ({
            closeWindow: jest.fn(async () => {}),
        }));

        const result = await executeCloseWindow(
            {
                actionName: "closeWindow",
                parameters: {
                    title: "Quarterly Forecast Dashboard - Window 2",
                },
            },
            getControl,
        );

        expect(result).toEqual({
            error: "Closing a browser window by title is not supported. The current window was left open.",
        });
        expect(getControl).not.toHaveBeenCalled();
    });

    test("closes the current window when no title is provided", async () => {
        const closeWindow = jest.fn(async () => {});
        const getControl = jest.fn(() => ({ closeWindow }));

        const result = await executeCloseWindow(
            {
                actionName: "closeWindow",
                parameters: {},
            },
            getControl,
        );

        expect(result).toBeUndefined();
        expect(getControl).toHaveBeenCalledTimes(1);
        expect(closeWindow).toHaveBeenCalledTimes(1);
    });
});

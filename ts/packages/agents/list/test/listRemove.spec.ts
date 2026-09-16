// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    ActionContext,
    Storage,
    TokenCachePersistence,
} from "@typeagent/agent-sdk";
import { instantiate } from "../src/listActionHandler.js";

class MemoryStorage implements Storage {
    private readonly data = new Map<string, string>();
    public writes = 0;

    constructor(lists: { name: string; items: string[] }[]) {
        this.data.set("lists.json", JSON.stringify(lists));
    }

    async read(storagePath: string): Promise<Uint8Array>;
    async read(
        storagePath: string,
        options: "utf8" | "base64",
    ): Promise<string>;
    async read(storagePath: string, options?: "utf8" | "base64") {
        const value = this.data.get(storagePath);
        if (value === undefined) {
            throw new Error(`File not found: ${storagePath}`);
        }
        return options === undefined ? new TextEncoder().encode(value) : value;
    }

    async write(storagePath: string, data: string | Uint8Array) {
        this.writes++;
        this.data.set(
            storagePath,
            typeof data === "string" ? data : new TextDecoder().decode(data),
        );
    }

    async list() {
        return Array.from(this.data.keys());
    }

    async exists(storagePath: string) {
        return this.data.has(storagePath);
    }

    async delete(storagePath: string) {
        this.data.delete(storagePath);
    }

    async getTokenCachePersistence(): Promise<TokenCachePersistence> {
        return {
            load: async () => null,
            save: async () => {},
            delete: async () => true,
        };
    }

    getLists() {
        return JSON.parse(this.data.get("lists.json") ?? "[]");
    }
}

async function createAgent(lists: { name: string; items: string[] }[]) {
    const agent = instantiate();
    const agentContext = await agent.initializeAgentContext!();
    const storage = new MemoryStorage(lists);
    const sessionContext = {
        agentContext,
        sessionStorage: storage,
    } as any;
    await agent.updateAgentContext!(true, sessionContext, "list");
    const actionContext = {
        sessionContext,
    } as ActionContext<any>;
    return { agent, actionContext, storage };
}

async function removeItem(
    agent: ReturnType<typeof instantiate>,
    actionContext: ActionContext<any>,
    listName: string,
    item = "apple",
) {
    return agent.executeAction!(
        {
            schemaName: "list",
            actionName: "removeItems",
            parameters: { listName, items: [item] },
        },
        actionContext,
    );
}

describe("removeItems", () => {
    test("returns an error without saving when the list does not exist", async () => {
        const { agent, actionContext, storage } = await createAgent([]);

        const result = (await removeItem(
            agent,
            actionContext,
            "audit-missing-20260915",
        )) as any;

        expect(result).toEqual({
            error: "List 'audit-missing-20260915' not found",
        });
        expect(result.entities).toBeUndefined();
        expect(storage.getLists()).toEqual([]);
        expect(storage.writes).toBe(0);
    });

    test("removes an item from an existing list and saves the result", async () => {
        const { agent, actionContext, storage } = await createAgent([
            { name: "grocery", items: ["apple"] },
        ]);

        const result = (await removeItem(
            agent,
            actionContext,
            "grocery",
        )) as any;

        expect(result.historyText).toBe(
            "Removed items: apple from list grocery",
        );
        expect(result.entities).toEqual([{ name: "grocery", type: ["list"] }]);
        expect(storage.getLists()).toEqual([{ name: "grocery", items: [] }]);
        expect(storage.writes).toBe(1);
    });

    test("keeps an existing list unchanged when the item is absent", async () => {
        const { agent, actionContext, storage } = await createAgent([
            { name: "grocery", items: ["apple"] },
        ]);

        const result = (await removeItem(
            agent,
            actionContext,
            "grocery",
            "pear",
        )) as any;

        expect(result.historyText).toBe(
            "Removed items: pear from list grocery",
        );
        expect(result.entities).toEqual([
            {
                name: "grocery",
                type: ["list"],
                facets: [{ name: "items", value: ["apple"] }],
            },
        ]);
        expect(storage.getLists()).toEqual([
            { name: "grocery", items: ["apple"] },
        ]);
        expect(storage.writes).toBe(1);
    });
});

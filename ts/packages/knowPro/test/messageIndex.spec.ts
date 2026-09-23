// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createTextEmbeddingIndexSettings } from "../src/fuzzyIndex.js";
import { addToMessageIndex, MessageTextIndex } from "../src/messageIndex.js";
import { TestConversation } from "./testCommon.js";
import { TestMessage } from "./testMessage.js";

const settings = {
    embeddingIndexSettings: createTextEmbeddingIndexSettings(
        {
            maxBatchSize: 1,
            generateEmbedding: async () => ({
                success: true as const,
                data: [1, 0],
            }),
        },
        2,
    ),
};

function locations(index: MessageTextIndex) {
    return index.serialize().indexData?.textLocations;
}

describe("message text index ordinals", () => {
    test("uses message rather than chunk ordinals across incremental calls", async () => {
        const index = new MessageTextIndex(settings);
        expect(
            (await index.addMessages([new TestMessage(["a", "b"])], 0))
                .numberCompleted,
        ).toBe(2);
        await index.addMessages([new TestMessage("c")], 1);

        expect(locations(index)).toEqual([
            { messageOrdinal: 0, chunkOrdinal: 0 },
            { messageOrdinal: 0, chunkOrdinal: 1 },
            { messageOrdinal: 1, chunkOrdinal: 0 },
        ]);
    });

    test("uses each batch start ordinal when building and extending", async () => {
        const conversation = new TestConversation(
            "test",
            [],
            [
                new TestMessage(["a", "b"]),
                new TestMessage("c"),
                new TestMessage(["d", "e"]),
            ],
        );
        const index = new MessageTextIndex(settings);
        conversation.secondaryIndexes = { messageIndex: index };
        await addToMessageIndex(conversation, settings, 0, undefined, 1);
        conversation.messages.append(new TestMessage("f"));
        await addToMessageIndex(conversation, settings, 3, undefined, 1);

        expect(locations(index)).toEqual([
            { messageOrdinal: 0, chunkOrdinal: 0 },
            { messageOrdinal: 0, chunkOrdinal: 1 },
            { messageOrdinal: 1, chunkOrdinal: 0 },
            { messageOrdinal: 2, chunkOrdinal: 0 },
            { messageOrdinal: 2, chunkOrdinal: 1 },
            { messageOrdinal: 3, chunkOrdinal: 0 },
        ]);
    });
});

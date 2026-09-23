// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createTextEmbeddingIndexSettings } from "../src/fuzzyIndex.js";
import { TermEmbeddingIndex } from "../src/relatedTermsIndex.js";

function createIndex(failAfterFirstBatch = false) {
    let calls = 0;
    const settings = createTextEmbeddingIndexSettings(
        {
            maxBatchSize: 1,
            generateEmbedding: async () => {
                if (failAfterFirstBatch && ++calls > 1) {
                    return { success: false as const, message: "batch failed" };
                }
                return { success: true as const, data: [1, 0] };
            },
        },
        2,
    );
    settings.batchSize = 1;
    return new TermEmbeddingIndex(settings);
}

function expectRoundTrip(index: TermEmbeddingIndex, expected: string[]) {
    const serialized = index.serialize();
    expect(serialized.textItems).toEqual(expected);
    expect(serialized.embeddings).toHaveLength(expected.length);
    const restored = new TermEmbeddingIndex(index.settings);
    restored.deserialize(serialized);
    expect(restored.serialize().textItems).toEqual(expected);
}

describe("TermEmbeddingIndex.addTerms", () => {
    test("keeps only completed terms when indexing is cancelled", async () => {
        const index = createIndex();
        const result = await index.addTerms(["alpha", "beta", "gamma"], {
            onEmbeddingsCreated: (_texts, _batch, startAt) => startAt < 1,
        });

        expect(result.numberCompleted).toBe(1);
        expectRoundTrip(index, ["alpha"]);
    });

    test("keeps completed terms when a later batch fails", async () => {
        const index = createIndex(true);
        const result = await index.addTerms(["alpha", "beta", "gamma"]);

        expect(result.numberCompleted).toBe(1);
        expect(result.error).toBeDefined();
        expectRoundTrip(index, ["alpha"]);
    });
});

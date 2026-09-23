// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TermToSemanticRefIndex } from "../src/conversationIndex.js";

describe("TermToSemanticRefIndex.removeTerm", () => {
    test("removes only the requested reference for a shared term", () => {
        const index = new TermToSemanticRefIndex();
        index.addTerm("Shared", 0);
        index.addTerm("shared", 1);
        index.addTerm("shared", 0);

        index.removeTerm("SHARED", 0);

        expect(index.lookupTerm("shared")).toEqual([
            { semanticRefOrdinal: 1, score: 1 },
        ]);
        expect(index.getTerms()).toEqual(["shared"]);
        expect(index.serialize().items[0].semanticRefOrdinals).toEqual(
            index.lookupTerm("shared"),
        );
    });

    test("deletes a term only after its final posting is removed", () => {
        const index = new TermToSemanticRefIndex();
        index.addTerm("shared", 1);
        index.removeTerm("shared", 2);
        expect(index.lookupTerm("shared")).toHaveLength(1);

        index.removeTerm("shared", 1);
        expect(index.lookupTerm("shared")).toEqual([]);
        expect(index.getTerms()).toEqual([]);
    });
});

import assert from "node:assert/strict";
import test from "node:test";

import * as shared from "@workspace/knowledge-text";
import * as messageCitations from "./messageCitations.ts";
import * as knowledgeState from "./knowledgeState.ts";

// The citation display rules — the `[source:...]` marker grammar, segment
// parsing, archived-reference wording, and plain-text flattening — must be
// the shared implementations from @workspace/knowledge-text, not local copies
// that could drift from the desktop workspace. Reference identity (===) fails
// if anyone reintroduces a hand-written version behind the same export name.
test("phone citation display rules are the shared implementations, not local copies", () => {
  assert.equal(
    messageCitations.messageCitationSegments,
    shared.messageCitationSegments,
  );
  assert.equal(
    messageCitations.messageCitationPlainText,
    shared.messageCitationPlainText,
  );
  assert.equal(messageCitations.citedCitationIds, shared.citedCitationIds);
  assert.equal(
    messageCitations.citationUrlIdentity,
    shared.citationUrlIdentity,
  );
  assert.equal(
    messageCitations.ARCHIVED_CITATION_LABEL,
    shared.ARCHIVED_CITATION_LABEL,
  );
  assert.equal(
    knowledgeState.knowledgeDisplayText,
    shared.knowledgeDisplayText,
  );
});

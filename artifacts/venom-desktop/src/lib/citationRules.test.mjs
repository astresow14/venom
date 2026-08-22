import assert from 'node:assert/strict';
import test from 'node:test';

import * as shared from '@workspace/knowledge-text';
import * as desktop from './messageCitations.ts';
import * as phone from '../../../venom/context/messageCitations.ts';
import * as phoneKnowledge from '../../../venom/context/knowledgeState.ts';

// ---------------------------------------------------------------------------
// Reference-identity guards: both apps must export the shared citation display
// rules — marker parsing, archived-reference wording, plain-text flattening —
// from @workspace/knowledge-text, never local copies. `===` fails as soon as
// either side reintroduces a hand-written version behind the same name.
// ---------------------------------------------------------------------------

test('desktop citation display rules are the shared implementations, not local copies', () => {
  assert.equal(desktop.messageCitationSegments, shared.messageCitationSegments);
  assert.equal(
    desktop.messageCitationPlainText,
    shared.messageCitationPlainText,
  );
  assert.equal(desktop.knowledgeDisplayText, shared.knowledgeDisplayText);
  assert.equal(desktop.citedCitationIds, shared.citedCitationIds);
  assert.equal(desktop.citationUrlIdentity, shared.citationUrlIdentity);
  assert.equal(desktop.ARCHIVED_CITATION_LABEL, shared.ARCHIVED_CITATION_LABEL);
});

test('phone and desktop resolve cited sources with the identical functions', () => {
  assert.equal(desktop.messageCitationSegments, phone.messageCitationSegments);
  assert.equal(
    desktop.messageCitationPlainText,
    phone.messageCitationPlainText,
  );
  assert.equal(desktop.citedCitationIds, phone.citedCitationIds);
  assert.equal(desktop.citationUrlIdentity, phone.citationUrlIdentity);
  assert.equal(desktop.ARCHIVED_CITATION_LABEL, phone.ARCHIVED_CITATION_LABEL);
  assert.equal(
    desktop.knowledgeDisplayText,
    phoneKnowledge.knowledgeDisplayText,
  );
});

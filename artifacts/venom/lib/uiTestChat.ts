

// Browser UI tests run without a Clerk session, so chat uses a stand-in
// identity and token that only exist in the development UI-test bundle.
export const UI_TEST_CHAT_TOKEN = "venom-ui-test-chat-token";

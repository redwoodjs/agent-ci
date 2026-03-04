Feature: Conversation discovery
  Scenario: Conversations for other branches are ignored
    Given the user is in a git repository on branch "feature-x"
    And Claude Code conversations exist for both "feature-x" and "other-branch"
    When the user runs derive
    Then only conversations for "feature-x" contribute to the spec

  Scenario: Multiple conversations are associated with a single branch
    Given two or more Claude Code conversations exist for the same branch
    When the user runs derive
    Then all conversations for that branch contribute to the spec update

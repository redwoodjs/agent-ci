Feature: Watch mode
  Scenario: Watch runs an initial update on start
    Given the user is in a git repository on branch "feature-x"
    And conversations with new messages exist for this branch
    When the user runs derive watch
    Then an initial spec update runs immediately
    And the watcher begins monitoring for subsequent changes

  Scenario: Watch triggers update on conversation change
    Given the user has started derive watch on branch "feature-x"
    When a conversation file for this branch is modified
    Then after a debounce period the spec .feature files are updated with new behaviours

  Scenario: Watch discovers new conversations
    Given the user has started derive watch on branch "feature-x"
    When a new conversation file appears for this branch
    Then the new conversation is discovered and indexed
    And its messages are included in the next spec update

  Scenario: Watch ignores conversations for other branches
    Given the user has started derive watch on branch "feature-x"
    When a conversation file changes that belongs to branch "other-branch"
    Then no spec update is triggered for "other-branch"

  Scenario: Rapid file changes are coalesced into a single update
    Given the user has started derive watch on branch "feature-x"
    When a conversation file receives multiple writes in quick succession
    Then a single spec update is triggered after the writes stabilise

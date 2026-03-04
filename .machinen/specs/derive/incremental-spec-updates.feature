Feature: Incremental spec updates
  Scenario: Spec is updated when new conversation data arrives
    Given a branch already has spec files from a previous run
    And new conversation messages have been recorded for that branch
    When the user runs derive
    Then the spec files are updated to reflect the new conversation content
    And previously captured behaviours that are still valid are preserved

  Scenario: Large conversations are processed completely
    Given a conversation contains a large volume of messages
    When the user runs derive
    Then all message content is included in spec generation
    And the resulting spec reflects the full conversation

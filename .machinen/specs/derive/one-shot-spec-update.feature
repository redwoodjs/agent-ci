Feature: One-shot spec update
  Scenario: Update spec for current branch
    Given the user is in a git repository on branch "feature-x"
    And some conversations have new messages since the last run
    When the user runs derive
    Then the spec .feature files are updated with behaviours extracted from the new messages
    And the process exits

  Scenario: No new messages since last run
    Given the user is in a git repository on branch "feature-x"
    And all conversations have been fully processed by a previous run
    When the user runs derive
    Then no spec update is performed
    And the process exits

  Scenario: No conversations found for the branch
    Given the user is in a git repository on branch "feature-x"
    And no Claude Code conversations exist for this repository and branch
    When the user runs derive
    Then a message indicates no conversations were found
    And the process exits

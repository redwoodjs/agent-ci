Feature: CLI context detection
  Scenario: Branch is inferred from the current git repository
    Given the user is in a git repository on branch "feature-x"
    When the user runs derive
    Then derive operates on branch "feature-x"
    And the repository path is inferred from the current working directory

  Scenario: Detached HEAD is rejected
    Given the user is in a git repository with a detached HEAD
    When the user runs derive
    Then an error message indicates a named branch is required
    And the process exits with a non-zero code

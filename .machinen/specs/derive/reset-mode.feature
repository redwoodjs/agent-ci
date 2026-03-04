Feature: Reset mode
  Scenario: Running --reset regenerates the spec from scratch
    Given the user is in a git repository on branch "feature-x"
    And spec .feature files exist for this branch
    And conversations have been partially processed
    When the user runs derive --reset
    Then all existing .feature files are deleted
    And all conversations are reprocessed from the beginning
    And new .feature files are generated from all available conversation data
    And the process exits

  Scenario: Reset with --keep-spec preserves existing spec files
    Given the user is in a git repository on branch "feature-x"
    And .feature files exist with user-written content
    And conversations exist for this branch
    When the user runs derive --reset --keep-spec
    Then the existing .feature files are not deleted
    And all conversations are reprocessed with the existing spec as starting context
    And the process exits

  Scenario: Reset with no conversations reports no data
    Given the user is in a git repository on branch "feature-x"
    And no conversations have been recorded for this branch
    When the user runs derive --reset
    Then a message indicates no conversations were found

  Scenario: Reset discovers new conversations before reprocessing
    Given the user is in a git repository on branch "feature-x"
    And new conversation files exist that were never indexed
    When the user runs derive --reset
    Then the new conversations are discovered
    And all conversations including the newly discovered ones are reprocessed

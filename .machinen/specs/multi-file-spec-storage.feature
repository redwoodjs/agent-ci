Feature: Multi-file spec storage
  Scenario: Spec output is split into per-feature files
    Given a derive run produces Gherkin with multiple Feature blocks
    When the spec is written to disk
    Then each Feature block is written to a separate .feature file in .machinen/specs/
    And each file is named by slugifying the Feature name

  Scenario: Feature name slugification
    Given a Feature block named "CLI spec update"
    When the spec is written to disk
    Then the file is named "cli-spec-update.feature"

  Scenario: Old feature files are removed before writing
    Given .machinen/specs/ contains feature files from a previous run
    When a new spec is written
    Then all existing .feature files are removed
    And only the new feature files are written

  Scenario: Existing spec files are used as starting context
    Given .feature files exist in .machinen/specs/
    When the user runs derive
    Then the existing spec content is concatenated and used as context for the update
    And the updated spec is split back into per-feature files

  Scenario: Iterative results are visible on disk between chunks
    Given a spec update involves multiple chunks of conversation data
    When a chunk completes
    Then the intermediate result is written as split .feature files
    And the next chunk reads the concatenated result back from disk

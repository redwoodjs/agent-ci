Feature: Scope flag
  Scenario: Spec files are written to a scoped subdirectory when --scope is provided
    Given the user is in a git repository on branch "feature-x"
    When the user runs derive --scope derive
    Then spec .feature files are written to .machinen/specs/derive/
    And no .feature files are written directly to .machinen/specs/

  Scenario: Spec files are read from a scoped subdirectory when --scope is provided
    Given .feature files exist in .machinen/specs/derive/
    When the user runs derive --scope derive
    Then the existing spec content is read from .machinen/specs/derive/
    And the updated spec is written back to .machinen/specs/derive/

  Scenario: Reset respects --scope flag
    Given spec .feature files exist in .machinen/specs/derive/
    When the user runs derive --reset --scope derive
    Then the .feature files in .machinen/specs/derive/ are deleted and regenerated
    And files outside .machinen/specs/derive/ are not affected

  Scenario: Without --scope spec files use the default location
    Given the user is in a git repository on branch "feature-x"
    When the user runs derive without the --scope flag
    Then spec .feature files are written to .machinen/specs/

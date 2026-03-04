Feature: Spec file location
  Scenario: Spec files are stored in the project directory
    Given the user is in a git repository at /path/to/project
    When a spec is created or updated
    Then spec files are written to /path/to/project/.machinen/specs/

  Scenario: Spec files travel with the git branch
    Given spec files exist in .machinen/specs/ on branch "feature-x"
    When the user switches to branch "main" and back to "feature-x"
    Then the spec files for "feature-x" are present on the branch

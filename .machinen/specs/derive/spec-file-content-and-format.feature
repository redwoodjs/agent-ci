Feature: Spec file content and format
  Scenario: Spec output is valid Gherkin
    Given conversation excerpts are available for a branch
    When the spec files are generated
    Then the files contain Feature blocks with Scenario entries using Given/When/Then steps
    And the files do not contain preamble or commentary outside the Gherkin structure

  Scenario: Spec contains only externally observable behaviours
    Given conversation excerpts reference both internal implementation details and externally observable behaviours
    When the spec files are generated
    Then the spec includes only behaviours verifiable through the product's external interfaces
    And the spec does not include scenarios about internal function calls, database schemas, environment variables, or subprocess flags

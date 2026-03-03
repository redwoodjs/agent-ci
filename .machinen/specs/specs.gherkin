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

Feature: Conversation discovery
  Scenario: New conversations are discovered on first run
    Given the user is in a git repository on branch "feature-x"
    And Claude Code conversations exist for this repository and branch
    And no previous derive run has occurred
    When the user runs derive
    Then the conversations are discovered and indexed
    And their messages are included in the spec update

  Scenario: Conversations for other branches are ignored
    Given the user is in a git repository on branch "feature-x"
    And Claude Code conversations exist for both "feature-x" and "other-branch"
    When the user runs derive
    Then only conversations for "feature-x" contribute to the spec

  Scenario: Multiple conversations are associated with a single branch
    Given two or more Claude Code conversations exist for the same branch
    When the user runs derive
    Then all conversations for that branch contribute to the spec update

Feature: One-shot spec update
  Scenario: Update spec for current branch
    Given the user is in a git repository on branch "feature-x"
    And Claude Code conversations exist for this repository and branch
    And some conversations have new messages since the last run
    When the user runs derive
    Then the spec file is updated with behaviours extracted from the new messages
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

Feature: Reset mode
  Scenario: Running --reset regenerates the spec from scratch
    Given the user is in a git repository on branch "feature-x"
    And a spec file exists for this branch
    And conversations have been partially processed
    When the user runs derive --reset
    Then the existing spec file is deleted
    And all conversations are reprocessed from the beginning
    And a new spec is generated from all available conversation data
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
    Then after a debounce period the spec file is updated with new behaviours

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

Feature: Init mode
  Scenario: Create empty spec file for manual seeding
    Given the user is in a git repository on branch "feature-x"
    And no spec file exists at .machinen/specs/feature-x.gherkin
    When the user runs derive init
    Then an empty file is created at .machinen/specs/feature-x.gherkin
    And the file path is printed to stdout

  Scenario: Init does not overwrite an existing spec
    Given the user is in a git repository on branch "feature-x"
    And a spec file already exists at .machinen/specs/feature-x.gherkin
    When the user runs derive init
    Then the existing file is not modified
    And a message indicates the spec already exists

Feature: Spec file location
  Scenario: Spec file is stored in the project directory
    Given the user is in a git repository at /path/to/project on branch "feature-x"
    When a spec is created or updated
    Then the spec file is written to /path/to/project/.machinen/specs/feature-x.gherkin

  Scenario: Spec file travels with the git branch
    Given a spec file exists at .machinen/specs/feature-x.gherkin on branch "feature-x"
    When the user switches to branch "main" and back to "feature-x"
    Then the spec file for "feature-x" is present on the branch

Feature: Spec file content and format
  Scenario: Spec output is Gherkin
    Given conversation excerpts are available for a branch
    When the spec file is generated
    Then the file contains Feature blocks with Scenario entries using Given/When/Then steps
    And the file does not contain preamble or commentary outside the Gherkin structure

  Scenario: Spec contains only externally observable behaviours
    Given conversation excerpts reference both internal implementation details and externally observable behaviours
    When the spec file is generated
    Then the spec includes only behaviours verifiable through the product's external interfaces
    And the spec does not include scenarios about internal function calls, database schemas, environment variables, or subprocess flags

Feature: Incremental spec updates
  Scenario: Spec is updated when new conversation data arrives
    Given a branch already has a spec file from a previous run
    And new conversation messages have been recorded for that branch
    When the user runs derive
    Then the spec file is updated to reflect the new conversation content

  Scenario: Previously captured behaviours are preserved
    Given a branch already has a spec file from a previous run
    When additional conversation messages arrive for that branch
    And the user runs derive
    Then the spec is revised in light of the new information
    And previously captured behaviours that are still valid are preserved

  Scenario: Existing spec is used as starting context
    Given a spec file exists at .machinen/specs/feature-x.gherkin with user-written content
    When the user runs derive
    Then the existing spec content is used as the starting point for the update
    And the updated spec incorporates both the existing content and new conversation data

  Scenario: Large conversations are processed completely
    Given a conversation contains a large volume of messages
    When the user runs derive
    Then all message content is included in spec generation
    And the resulting spec reflects the full conversation
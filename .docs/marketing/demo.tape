# Agent CI Demo — VHS Tape
# Records a terminal demo showing: pause-on-failure, fix, retry, pass.
#
# Prerequisites:
#   brew install vhs tmux
#   Docker running
#   cd .docs/marketing/project && npm install && cd ../../..
#
# Record:
#   cd .docs/marketing && vhs demo.tape

Output demo.gif

Require tmux

Set Shell "bash"
Set FontSize 14
Set Width 1400
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 40ms
Set Framerate 30

# --- Boot tmux with two vertical panes ---

Hide
Type "tmux -f /dev/null -L demo new-session -x 170 -y 40 -- bash"
Enter
Sleep 1s
# Set PATH first so the split-window -e can inherit it
Type "export PATH=/Users/peterp/gh/redwoodjs/agent-ci/.docs/marketing/.bin:$PATH"
Enter
Type "tmux split-window -d -h -l 55 -e PATH=$PATH -- bash"
Enter
Sleep 500ms
Type "tmux setw pane-border-style fg=colour238"
Enter
Type "tmux setw pane-active-border-style fg=colour238"
Enter
# Reset the failure state for a clean recording
Type "echo fail > project/value.txt"
Enter
Sleep 500ms
Type "cd project"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 500ms
Show

# === ACT 1: Show what we're working with ===

Sleep 1s

# Show the workflow file — standard GitHub Actions
Type "cat .github/workflows/ci.yml"
Enter
Sleep 4s

# Show the broken test value
Type "cat value.txt"
Enter
Sleep 2s

# === ACT 2: Run agent-ci — it starts instantly (0ms cold cache) ===

Type "agent-ci run --workflow .github/workflows/ci.yml --pause-on-failure"
Enter

# Wait for the runner to start and the test to fail (up to 2 minutes)
Wait+Screen@120s /Step failed/
Sleep 3s

# === ACT 3: Fix the bug in the right pane ===

# Switch to right pane using tmux prefix + arrow
Ctrl+B
Right
Sleep 500ms

Type "cd project"
Enter
Sleep 500ms

# Show the broken value
Type "cat value.txt"
Enter
Sleep 2s

# Fix it
Type@80ms "echo pass > value.txt"
Enter
Sleep 1s

# Verify the fix
Type "cat value.txt"
Enter
Sleep 2s

# Retry using the agent-ci retry command
Type@80ms "agent-ci retry --name $(docker ps --format '{{.Names}}' | grep agent-ci)"
Enter
Sleep 1s

# === ACT 4: Switch back to left pane to watch it pass ===

Ctrl+B
Left
Sleep 500ms

Wait+Screen@120s /passed/
Sleep 5s

# === END ===

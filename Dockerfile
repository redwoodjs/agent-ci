FROM node:22-slim

EXPOSE 8910/tcp
EXPOSE 8911/tcp

# Install wget for pnpm installation
RUN apt-get update && apt-get install -y wget sudo && rm -rf /var/lib/apt/lists/*

RUN corepack enable 

# Install Claude Code CLI as root
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user with sudo access
RUN useradd -m -s /bin/bash nodeuser && \
    echo "nodeuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up app directory
WORKDIR /app
COPY ./container/ .
RUN chown -R nodeuser:nodeuser /app

# Switch to non-root user
USER nodeuser

# Install pnpm as nodeuser
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -
RUN export PATH="$HOME/.local/share/pnpm:$PATH" && pnpm install

# Set up Claude settings with proper permissions structure
RUN mkdir -p /home/nodeuser/.claude && \
    echo '{\
  "permissions": {\
    "defaultMode": "acceptEdits",\
    "allow": [\
      "Agent(*)",\
      "Bash(*)",\
      "Edit(*)",\
      "Glob(*)",\
      "Grep(*)",\
      "LS(*)",\
      "MultiEdit(*)",\
      "NotebookEdit(*)",\
      "NotebookRead(*)",\
      "Read(*)",\
      "TodoRead(*)",\
      "TodoWrite(*)",\
      "WebFetch(*)",\
      "WebSearch(*)",\
      "Write(*)"\
    ]\
  }\
}' > /home/nodeuser/.claude/settings.json

CMD ["pnpm", "run", "dev:all"]
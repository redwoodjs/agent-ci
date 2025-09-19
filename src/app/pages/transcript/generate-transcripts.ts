"use server";

interface CommitInfo {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body?: string;
}

interface TranscriptEntry {
  id: string;
  timestamp: string;
  speaker: string;
  text: string;
  confidence: number;
}

interface Transcript {
  id: string;
  meetingId: string;
  title: string;
  createdAt: string;
  duration: number;
  participants: string[];
  entries: TranscriptEntry[];
}

const SPEAKERS = ["Peter", "Justin", "Herman", "Alice", "Sarah"];

// Map real authors to consistent speaker names
const AUTHOR_MAP: Record<string, string> = {
  "Peter Pistorius": "Peter",
  "justinvdm": "Justin",
  "Herman Olivier": "Herman",
};

function getRandomSpeaker(exclude?: string): string {
  const available = SPEAKERS.filter(s => s !== exclude);
  return available[Math.floor(Math.random() * available.length)];
}

function generateConversation(commits: CommitInfo[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let currentTime = new Date(commits[0].date);
  let entryId = 1;

  // Group commits by theme/feature
  const commitGroups = groupCommitsByTheme(commits);

  for (const [theme, themeCommits] of commitGroups) {
    const conversation = generateThemeConversation(theme, themeCommits, currentTime, entryId);
    entries.push(...conversation);
    entryId += conversation.length;
    
    // Add some time between different topics
    currentTime = new Date(currentTime.getTime() + 60000 * 5); // 5 minutes
  }

  return entries;
}

function groupCommitsByTheme(commits: CommitInfo[]): Map<string, CommitInfo[]> {
  const groups = new Map<string, CommitInfo[]>();
  
  for (const commit of commits) {
    let theme = "General Development";
    
    if (commit.subject.toLowerCase().includes("opencode") || commit.body?.toLowerCase().includes("opencode")) {
      theme = "OpenCode Integration";
    } else if (commit.subject.toLowerCase().includes("chat") || commit.subject.toLowerCase().includes("prompt")) {
      theme = "Chat System";
    } else if (commit.subject.toLowerCase().includes("auth") || commit.subject.toLowerCase().includes("login")) {
      theme = "Authentication";
    } else if (commit.subject.toLowerCase().includes("lane") || commit.subject.toLowerCase().includes("task")) {
      theme = "Task Management";
    } else if (commit.subject.toLowerCase().includes("preview") || commit.subject.toLowerCase().includes("pageview")) {
      theme = "Analytics & Preview";
    } else if (commit.subject.toLowerCase().includes("deps") || commit.subject.toLowerCase().includes("upgrade")) {
      theme = "Dependencies";
    } else if (commit.subject.toLowerCase().includes("fix") || commit.subject.toLowerCase().includes("cleanup")) {
      theme = "Bug Fixes";
    }
    
    if (!groups.has(theme)) {
      groups.set(theme, []);
    }
    groups.get(theme)!.push(commit);
  }
  
  return groups;
}

function generateThemeConversation(theme: string, commits: CommitInfo[], startTime: Date, startId: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let currentTime = new Date(startTime);
  let currentId = startId;
  
  // Get primary author for this theme
  const primaryAuthor = AUTHOR_MAP[commits[0].author] || "Peter";
  
  // Generate opening discussion
  const opener = generateOpening(theme, primaryAuthor, currentTime, currentId++);
  entries.push(opener);
  currentTime = new Date(currentTime.getTime() + 7000); // 7 seconds later
  
  // Generate discussion around specific commits
  for (const commit of commits.slice(0, 3)) { // Discuss first few commits
    const discussion = generateCommitDiscussion(commit, currentTime, currentId);
    entries.push(...discussion);
    currentId += discussion.length;
    currentTime = new Date(currentTime.getTime() + discussion.length * 8000); // 8 seconds per entry
  }
  
  // Add closing thoughts
  const closer = generateClosing(theme, getRandomSpeaker(primaryAuthor), currentTime, currentId);
  entries.push(closer);
  
  return entries;
}

function generateOpening(theme: string, speaker: string, time: Date, id: number): TranscriptEntry {
  const openings: Record<string, string[]> = {
    "OpenCode Integration": [
      "Alright team, let's talk about the OpenCode integration we've been working on.",
      "So I've been experimenting with OpenCode and I think we're onto something here.",
      "The OpenCode experiment is showing some promising results, let me walk you through what I found."
    ],
    "Chat System": [
      "We need to discuss the chat streaming improvements I've been working on.",
      "The chat prompt system needs some attention - I've made some changes.",
      "Let's review the chat functionality and the streaming issues we've been having."
    ],
    "Task Management": [
      "I want to go over the lane and task management updates.",
      "The kanban board functionality is coming together, let me show you what's working.",
      "We need to discuss how the task system integrates with our chat sessions."
    ],
    "Analytics & Preview": [
      "I've been working on the preview functionality and pageview tracking.",
      "Let's review the analytics implementation and see what data we're capturing.",
      "The preview system is working but there are some edge cases we need to handle."
    ],
    "Bug Fixes": [
      "I've been cleaning up some technical debt and fixing bugs.",
      "There were several issues I tackled in the latest commits, let me run through them.",
      "Time for some housekeeping - I fixed several nagging issues."
    ],
    "Dependencies": [
      "I upgraded our dependencies to the latest versions.",
      "Let's talk about the dependency updates and what changed.",
      "I updated to rwsdk v1.0 - there are some breaking changes to discuss."
    ]
  };
  
  const messages = openings[theme] || openings["General Development"] || ["Let's discuss the latest changes I made."];
  const message = messages[Math.floor(Math.random() * messages.length)];
  
  return {
    id: `entry-${id}`,
    timestamp: time.toISOString(),
    speaker,
    text: message,
    confidence: 0.92 + Math.random() * 0.06
  };
}

function generateCommitDiscussion(commit: CommitInfo, startTime: Date, startId: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let currentTime = new Date(startTime);
  let currentId = startId;
  
  const primarySpeaker = AUTHOR_MAP[commit.author] || "Peter";
  
  // Primary speaker explains the change
  const explanation = generateCommitExplanation(commit, primarySpeaker, currentTime, currentId++);
  entries.push(explanation);
  currentTime = new Date(currentTime.getTime() + 9000);
  
  // Someone asks a question or provides feedback
  if (Math.random() > 0.3) { // 70% chance of discussion
    const responder = getRandomSpeaker(primarySpeaker);
    const response = generateResponse(commit, responder, currentTime, currentId++);
    entries.push(response);
    currentTime = new Date(currentTime.getTime() + 6000);
    
    // Original speaker responds back
    if (Math.random() > 0.4) { // 60% chance of follow-up
      const followUp = generateFollowUp(commit, primarySpeaker, currentTime, currentId++);
      entries.push(followUp);
    }
  }
  
  return entries;
}

function generateCommitExplanation(commit: CommitInfo, speaker: string, time: Date, id: number): TranscriptEntry {
  const subject = commit.subject;
  
  // Generate contextual explanations based on commit messages
  let explanation: string;
  
  if (subject.includes("Fix") || subject.includes("fix")) {
    explanation = `I fixed ${subject.toLowerCase().replace(/^fix\s+/, "")}. It was causing some issues in production.`;
  } else if (subject.includes("Add") || subject.includes("add")) {
    explanation = `I added ${subject.toLowerCase().replace(/^add\s+/, "")}. This should improve our user experience.`;
  } else if (subject.includes("Remove") || subject.includes("remove")) {
    explanation = `I removed ${subject.toLowerCase().replace(/^remove\s+/, "")} since it wasn't being used anymore.`;
  } else if (subject.includes("Upgrade") || subject.includes("upgrade")) {
    explanation = `I upgraded our dependencies. This brings in some security fixes and new features.`;
  } else if (subject.includes("Cleanup") || subject.includes("cleanup")) {
    explanation = `Did some cleanup work - removed dead code and organized things better.`;
  } else if (subject.includes("Massive changes")) {
    explanation = `This was a big refactor. I had to restructure how we handle the container integration.`;
  } else if (subject.includes("opencode") || subject.toLowerCase().includes("opencode")) {
    explanation = `The OpenCode integration is working now. Users can interact with AI directly in their development environment.`;
  } else {
    explanation = `I worked on ${subject.toLowerCase()}. This should make the system more reliable.`;
  }
  
  return {
    id: `entry-${id}`,
    timestamp: time.toISOString(),
    speaker,
    text: explanation,
    confidence: 0.88 + Math.random() * 0.08
  };
}

function generateResponse(commit: CommitInfo, speaker: string, time: Date, id: number): TranscriptEntry {
  const responses = [
    "That makes sense. How did you test it?",
    "Good catch. I was wondering why that wasn't working properly.",
    "Nice work! Does this affect the existing functionality?",
    "I like this approach. Much cleaner than before.",
    "Were there any edge cases you had to handle?",
    "This should make development much smoother.",
    "How does this integrate with what we built last week?",
    "Did you run into any issues during the implementation?",
    "Perfect timing - I was just about to ask about this.",
    "This resolves the issue we discussed earlier, right?"
  ];
  
  const response = responses[Math.floor(Math.random() * responses.length)];
  
  return {
    id: `entry-${id}`,
    timestamp: time.toISOString(),
    speaker,
    text: response,
    confidence: 0.90 + Math.random() * 0.08
  };
}

function generateFollowUp(commit: CommitInfo, speaker: string, time: Date, id: number): TranscriptEntry {
  const followUps = [
    "Yeah, I tested it locally and in staging. Everything looks good.",
    "Exactly. No breaking changes, just internal improvements.",
    "I handled the main scenarios, but we should keep an eye on it in production.",
    "It's backward compatible, so existing code should work fine.",
    "The tests are passing, but I want to monitor it for a few days.",
    "Right, this addresses that performance issue we've been seeing.",
    "I documented the changes in the PR, so the team knows what changed.",
    "No major issues, just had to refactor a few helper functions.",
    "That's the plan. This should make future development easier.",
    "Correct. It's a much more robust solution now."
  ];
  
  const followUp = followUps[Math.floor(Math.random() * followUps.length)];
  
  return {
    id: `entry-${id}`,
    timestamp: time.toISOString(),
    speaker,
    text: followUp,
    confidence: 0.86 + Math.random() * 0.10
  };
}

function generateClosing(theme: string, speaker: string, time: Date, id: number): TranscriptEntry {
  const closings = [
    "Alright, I think that covers everything for now. Let's move on.",
    "Sounds good. I'll keep monitoring this and let you know if anything comes up.",
    "Great work on this. Should we schedule a follow-up to review the impact?",
    "I'm happy with where this is heading. Nice job everyone.",
    "This should be stable now. I'll document the changes for the team.",
    "Perfect. Let's see how users respond to these improvements.",
    "I think we're in a good place with this feature now.",
    "Excellent progress. This puts us ahead of schedule."
  ];
  
  const closing = closings[Math.floor(Math.random() * closings.length)];
  
  return {
    id: `entry-${id}`,
    timestamp: time.toISOString(),
    speaker,
    text: closing,
    confidence: 0.91 + Math.random() * 0.06
  };
}

export function parseCommitHistory(commitData: string): CommitInfo[] {
  return commitData.split('\n')
    .filter(line => line.trim())
    .map(line => {
      const parts = line.split('|');
      return {
        hash: parts[0],
        author: parts[1],
        email: parts[2],
        date: parts[3],
        subject: parts[4],
        body: parts[5] || ''
      };
    });
}

export function generateTranscriptFromCommits(commits: CommitInfo[], containerId: string): Transcript[] {
  const transcripts: Transcript[] = [];
  
  // Group commits by date (daily meetings)
  const commitsByDate = new Map<string, CommitInfo[]>();
  
  commits.forEach(commit => {
    const dateKey = commit.date.split(' ')[0]; // YYYY-MM-DD
    if (!commitsByDate.has(dateKey)) {
      commitsByDate.set(dateKey, []);
    }
    commitsByDate.get(dateKey)!.push(commit);
  });
  
  // Generate transcript for each day with commits
  Array.from(commitsByDate.entries())
    .sort(([a], [b]) => b.localeCompare(a)) // Most recent first
    .slice(0, 5) // Last 5 days only
    .forEach(([dateKey, dayCommits], index) => {
      const meetingDate = new Date(dateKey + 'T10:00:00');
      const entries = generateConversation(dayCommits);
      
      const transcript: Transcript = {
        id: `transcript-${containerId}-${dateKey}-${Date.now()}`,
        meetingId: `meeting-${dateKey}-${Math.random().toString(36).substr(2, 9)}`,
        title: `Development Review - ${new Date(dateKey).toLocaleDateString('en-US', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })}`,
        createdAt: meetingDate.toISOString(),
        duration: entries.length * 12, // ~12 seconds per entry on average
        participants: [...new Set(entries.map(e => e.speaker))],
        entries
      };
      
      transcripts.push(transcript);
    });
  
  return transcripts;
}
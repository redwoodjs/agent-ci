# Planning - 2025-11-14 - Building the Context Stream

## What is a "Context Stream?"

When we work on a computer we interact with applications, we type, click, and communicate with team members over text and voice. Those interactions accumulate to produce the result of our work. Software engineers produce code. The deliverable.

Code is the thing that we value, but it's the result of a process, and a context stream is a way to keep a memory of the process. To make it searchable, reproducable and relevant for your entire team.

## What can you do with a Context Stream?

### From a developer's perspective?

<!-- TODO -->

### From a project manager's perspective

1. Hyper-Accurate Project Tracking and Forecasting
   The Problem: PMs rely on developers self-reporting progress, which can be subjective and often misses the "invisible work" of debugging, research, and refactoring. Story points and Gantt charts don't capture the messy reality of development.
   The Context Stream Solution: Instead of asking "Is this feature done yet?", a PM can see the actual activity around it. They can visualize the amount of time and events (code edits, terminal commands, page visits) being poured into a specific task. This allows for much more accurate, real-time progress tracking and helps in forecasting delays before they become critical. For example, if a "simple" 2-point story has generated a massive context stream, it's a clear, early indicator of hidden complexity.

2. Identifying and Resolving Bottlenecks
   The Problem: It's hard to know why a project is slowing down. Is it a slow CI/CD pipeline? A confusing third-party API? A developer who is stuck but not asking for help?
   The Context Stream Solution: By aggregating streams across the team, a PM can spot patterns. They could see that every developer working on the payment module spends hours on the same Stripe documentation pages, indicating a knowledge gap. They could quantify the exact amount of time the team spends waiting for builds to finish. This provides concrete data to justify investing in better documentation, training, or infrastructure.

3. Objective, Data-Driven Reporting
   The Problem: Reporting to stakeholders often relies on summaries that lack depth. Explaining why a deadline was missed can be difficult without concrete evidence.
   The Context Stream Solution: When a stakeholder asks why a feature was delayed, a PM can present a data-backed narrative. "The timeline shifted because we discovered the legacy API had undocumented rate limits. The team spent 2 days, involving 500+ events, building and testing a workaround. You can see the full, detailed history here." This builds credibility and shifts the conversation from blame to a shared understanding of the challenges.

4. Improved Team Health and Resource Allocation
   The Problem: Is the team burning out? Is one developer carrying the weight for a whole feature? It's hard to gauge from a Jira board.
   The Context Stream Solution: A PM could see if a developer's context stream is unusually long and fragmented, indicating constant context switching and potential burnout. They could also identify "keystone" engineers by seeing who is most frequently interacting with critical parts of the system, helping to manage risk and ensure knowledge is shared. It provides a more holistic view of workload than just the number of assigned tickets.

5. Maintaining the "Golden Thread" from Request to Delivery
   The Problem: Over the course of a project, the original "why" behind a feature can get lost through layers of interpretation.
   The Context Stream Solution: The stream can link the initial customer request in a support ticket, the subsequent Slack conversations, the Figma design file, the Jira story, and every single code commit. A PM can trace this "golden thread" at any time to ensure the work being done is still aligned with the original goal, preventing costly misunderstandings and rework.

### From a founder's perspective?

<!-- TODO -->

## What's stored in the context stream

The context stream always includes:

- A time
- Which phase in the development process is was recorded: "backlog," "todo," "in progress", "requires review", "in review", "done"
- The person of people in the call.

- Audio transcripts. The person, their role and everything they've said.
- Manual file edits.
- Chat history and responses with ai.
- Page loads
- Interaction with pages.
-

## TODO

- [ ] Capture visits to webpages.
- [ ] Capture files saved by human
- [ ] Capure files modified by AI.

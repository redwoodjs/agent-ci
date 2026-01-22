# Code Structure: Phase First

Historically, we organized our code by "type" (all workers together, all web handlers together). As the system grew, this made it difficult to understand the full lifecycle of a single feature. To fix this, we adopted a **Phase First** architecture.

## The Co-Location Principle

We group code by **Consumer Phase**, not by technical layer. If a piece of logic belongs to the "Linking" phase, it lives in the `deterministic_linking` directory, regardless of whether it's a backend runner, a web UI component, or a database model.

This co-location enforces clear ownership: `src/app/pipelines/<phase>/` contains everything required to understand that phase.

## Directory Layout

Each phase (e.g., `deterministic_linking`, `macro_synthesis`) follows a strict internal structure to separate the "Pure" logic from the "Runtime" plumbing.

```
src/app/pipelines/<phase>/
├── engine/
│   ├── core/         # The Brain (Shared Logic)
│   │   ├── domain.ts # Pure business rules & types
│   │   └── ops.ts    # I/O independent operations
│   │
│   ├── simulation/   # The Batch Runner (Simulation Adapter)
│   │   ├── runner.ts # Durable Object / Worker meant for batch replay
│   │   └── types.ts  # Simulation-specific artifact shapes
│   │
│   └── live/         # The Stream Processor (Live Adapter)
│       └── worker.ts # Queue consumer or webhook handler
│
└── web/              # The Human Interface
    ├── routes/       # API endpoints to inspect this phase's artifacts
    └── ui/           # Admin UI tailored to visualizing this phase
```

## The "Core" Distinction

The most important directory is `engine/core`. This is the "Brain" of the phase.

*   **It is Authoritative**: It defines the "Identity" of the work (e.g., how to hash inputs to detect changes).
*   **It is Shared**: Both the `simulation/` and `live/` adapters import their logic from here.

By forcing `simulation` and `live` to simply be wrappers around `core`, we guarantee that a simulation run is a truthful representation of live behavior. If you change a rule in `core`, it automatically propagates to both pipelines.

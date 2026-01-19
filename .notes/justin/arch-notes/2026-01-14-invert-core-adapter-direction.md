# Invert core-adapter direction (core orchestrates, ports injected)

## Context

We have phase cores that are pure-ish computation helpers, and live/simulation adapters that orchestrate I/O and call those cores.

That keeps computation shareable, but it still leaves a lot of phase behavior living in live code (even if it is under an adapters directory).

## Desired shape

The phase implementation should live in a shared module that:

- orchestrates the phase end-to-end
- calls injected ports for I/O (retrieval and writes)
- emits structured audit payloads and counters

Live and simulation then provide port implementations. This makes the shared phase implementation the source of truth for behavior, and makes the differences between live and simulation explicit and limited to port wiring.

## Terminology

- Phase orchestrator core: shared module that implements the phase by calling ports.
- Ports: interfaces for I/O, model calls, vector search, moment graph reads/writes, and configuration.
- Adapter: an implementation of the ports for a specific environment (live or simulation).

## Implications

- The current phase cores (candidate set filtering, deep timeline fit ranking, deterministic proposal shaping) become internal helpers inside the orchestrator core, or remain separate helpers but are no longer the top-level entrypoints used by live/simulation.
- Live code should not contain a phase-specific control flow that differs from simulation. If there is a difference, it should be representable as a port implementation difference.

## Migration strategy

Start with linking (E/F/G) since it is the main drift point:

- Create a shared linking orchestrator that implements:
  - Phase E: explicit reference resolution and within-stream chaining
  - Phase F: vector retrieval + candidate filtering/capping
  - Phase G: deep ranking and optional veto
- Define a ports interface that covers:
  - embedding and vector query
  - loading candidate moment rows
  - resolving explicit reference targets
  - applying the chosen parent link (write)
  - optional model call for veto
  - configuration values (candidate caps, token caps)
- Implement ports for:
  - simulation (persist artifacts + write moment graph)
  - live (minimal persistence + write moment graph audit payloads)

Then apply the same inversion to B/C/D so live does not have its own orchestration for planning and macro identity decisions.


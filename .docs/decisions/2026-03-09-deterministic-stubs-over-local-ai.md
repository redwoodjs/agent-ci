# Deterministic template stubs over local AI models for test doubles

## Decision

The substitute `claude` binary for e2e tests uses deterministic keyword extraction and Gherkin templating rather than local AI models. No `node-llama-cpp`, no GGUF downloads, no inference.

## Context

We investigated local AI models as test doubles for `claude -p`:

- SmolLM-135M (~105MB): produced Emacs Lisp gibberish, stuck in repetition loops
- Qwen3-0.6B (~484MB): produced coherent English but couldn't reliably follow Gherkin format without few-shot examples and post-processing hacks

The key realization: e2e tests verify derive's pipeline (read JSONL, call binary, parse result, write .feature files), not AI output quality. A deterministic template that produces structurally valid Gherkin is better in every dimension: zero flakiness, zero download friction, zero cost, ~0ms execution.

## Alternatives Considered

- **node-llama-cpp + tiny GGUF model**: 400-500MB download, non-deterministic output, requires `ensureGherkinStructure` post-processing hack. Rejected.
- **ollama**: requires daemon process, model download, CI infrastructure. Rejected.
- **BitNet**: promising 1-bit models but no llama.cpp compat, no Node.js bindings. Not ready.

## Consequences

- `fake-claude-gen-specs` is a pure Node script with `keyword-extractor` as only dependency
- `fake-claude-gen-tests` is a pure Node script with zero external dependencies
- Tests are deterministic and fast (~0ms stub execution)
- No model download step needed for test setup
- `node-llama-cpp` was added and then removed from the repo during the spike

## Worklog Reference

`.notes/justin/worklogs/2026-03-05-derive-test-generation.md`, sections "Spike: Model quality validation" and "Design pivot: deterministic template with keyword extraction"

# Worklog: High-Precision LLM Cost Tracking & Statistical Guardrails

**Date:** 2026-02-23  
**Author:** Gitub Copilot (AI)

## Objective
Implement a production-grade AI cost-tracking system for the Machinen Engine simulation suite. The goal was to move from "zero usage" visibility to a high-fidelity dashboard capable of predicting scaling impacts with 95% statistical confidence.

## Key Accomplishments

### 1. Infrastructure: Online Statistical Tracking
- **Welford's Algorithm Implementation**: Switched cost aggregation from simple sums to online variance tracking (Welford's Algorithm). This allows us to maintain standard deviation and mean in $O(1)$ time without storing individual call logs.
- **Dimensional Bucketing**: usage is aggregated by `model_alias`, `input_bucket`, and `output_bucket`. This isolates high-variance "interpreter" phases (Synthesis) from low-variance "metadata" phases (Classification).
- **Persistent Root DB Persistence**: Fixed architectural issues where cost records were being attempted in namespaced worker databases. Cost metadata is now strictly persisted to the **Root Simulation Database** to ensure a permanent, reliable audit trail.

### 2. Provider Robustness
- **Token Mapping Fixes**: Resolved issues where Cerebras and other AI-SDK providers returned `undefined` for `usage.promptTokens`. Implemented robust fallback mapping to normalize varying provider schemas (`inputTokens` vs `promptTokens`).

### 3. UI/UX: The Cost Analysis Dashboard
- **Projection Suite**: Added linear cost extrapolation for scale targets (100, 200, 500, 1000, 2000, 5000 documents) based on the current run average.
- **Statistical Guardrails**:
    - **Z=1.96**: Applied 95% Confidence Intervals for both bucket-level costs and global "Mean per Document."
    - **The Central Limit Theorem ($n \ge 30$)**: Added a visual "Statistically Significant" indicator. This ensures users do not make million-dollar scaling decisions based on a sample size of 2 or 3 fluky calls.
    - **Margin of Error (MoE)**: Displayed for all metrics to quantify the "wiggle room" in current estimates.

### 4. Code Health & Consistency
- **Service Layer Extraction**: Refactored document-counting and cost-fetching logic out of React components (IIFEs) and into dedicated service functions in `src/app/engine/simulation/`.
- **Theming**: Moved cost-related UI from "Success Green" to "Slate Grey" to distinguish economic assessments from operational success metrics.

## Technical Details
- **Variance Propagation**: Global standard deviation is calculated via $\sigma_{total} = \sqrt{\sum (\text{Bucket Variances})}$, allowing for a single high-precision error bar on the total run cost.
- **Database Schema**: Leverages `simulation_run_llm_costs` table with high-precision arithmetic columns (`mean_input_tokens`, `m2_input_tokens`).

## Impact
Researchers can now run a "small sample" simulation (e.g., 5-10 docs) and receive a mathematically sound prediction of exactly what a 10,000 document production run will cost, including the specific statistical uncertainty of that estimate.

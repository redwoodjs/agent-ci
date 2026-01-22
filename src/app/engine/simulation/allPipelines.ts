// This file imports all pipelines to trigger their registration in the pipelineRegistry.
// It must be imported by consumers who need a fully populated registry.

import "./registry"; // Ensure the registry is defined first

import "../../pipelines/r2_listing";
import "../../pipelines/ingest_diff";
import "../../pipelines/micro_batches";
import "../../pipelines/macro_synthesis";
import "../../pipelines/macro_classification";
import "../../pipelines/materialize_moments";
import "../../pipelines/deterministic_linking";
import "../../pipelines/candidate_sets";
import "../../pipelines/timeline_fit";

export * from "./registry";

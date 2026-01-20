// This file imports all pipelines to trigger their registration in the pipelineRegistry.
// It must be imported by consumers who need a fully populated registry.

import "./registry"; // Ensure the registry is defined first

import "../../pipelines/r2_listing/web";
import "../../pipelines/ingest_diff/web";
import "../../pipelines/micro_batches/web";
import "../../pipelines/macro_synthesis/web";
import "../../pipelines/macro_classification/web";
import "../../pipelines/materialize_moments/web";
import "../../pipelines/deterministic_linking/web";
import "../../pipelines/candidate_sets/web";
import "../../pipelines/timeline_fit/web";

export * from "./registry";

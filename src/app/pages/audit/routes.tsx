import { route, layout } from "rwsdk/router";

import { AuditLayout } from "./layout";
import { AuditDashboardPage } from "./subpages/audit-dashboard-page";
import { IngestionListPage } from "./subpages/ingestion-list-page";
import { IngestionFilePage } from "./subpages/ingestion-file-page";
import { IndexingStatusPage } from "./subpages/indexing-status-page";
import { QueryPage } from "./subpages/query-page";
import { KnowledgeGraphPage } from "./subpages/knowledge-graph-page";
import { NamespaceAuditPage } from "./subpages/namespace-audit-page";
import { NamespaceMomentsPage } from "./subpages/namespace-moments-page";
import { CodePage } from "./subpages/code-page";
import { ReplayRunLogPage } from "./subpages/replay-run-log-page";
import { SimulationRunsPage } from "./subpages/simulation-runs-page";
import { requireBasicAuth } from "@/app/ingestors/interruptors";

export const auditRoutes = [
  requireBasicAuth,
  layout(AuditLayout, [
    route("/", AuditDashboardPage),
    route("/ingestion", IngestionListPage),
    route("/ingestion/file/*", IngestionFilePage),
    route("/indexing", IndexingStatusPage),
    route("/query", QueryPage),
    route("/knowledge-graph", KnowledgeGraphPage),
    route("/replay-run-log", ReplayRunLogPage),
    route("/simulation", SimulationRunsPage),
    route("/namespace", NamespaceAuditPage),
    route("/namespace/moments", NamespaceMomentsPage),
  ]),
];

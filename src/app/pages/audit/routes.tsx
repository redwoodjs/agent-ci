import { route, layout } from "rwsdk/router";

import { AuditLayout } from "./layout";
import { AuditDashboardPage } from "./subpages/audit-dashboard-page";
import { IngestionListPage } from "./subpages/ingestion-list-page";
import { IngestionFilePage } from "./subpages/ingestion-file-page";
import { IndexingStatusPage } from "./subpages/indexing-status-page";
import { QueryPage } from "./subpages/query-page";
import { requireBasicAuth } from "@/app/ingestors/interruptors";

export const auditRoutes = [
  requireBasicAuth,
  layout(AuditLayout, [
    route("/", AuditDashboardPage),
    route("/ingestion", IngestionListPage),
    route("/ingestion/file/*", IngestionFilePage),
    route("/indexing", IndexingStatusPage),
    route("/query", QueryPage),
  ]),
];

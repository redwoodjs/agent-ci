import { route, layout } from "rwsdk/router";
import { requireAuth } from "../auth/interruptors";
import { AuditLayout } from "./layout";
import { AuditDashboardPage } from "./subpages/audit-dashboard-page";
import { IngestionListPage } from "./subpages/ingestion-list-page";
import { IndexingStatusPage } from "./subpages/indexing-status-page";

export const auditRoutes = [
  requireAuth,
  layout(AuditLayout, [
    route("/", AuditDashboardPage),
    route("/ingestion", IngestionListPage),
    route("/indexing", IndexingStatusPage),
  ]),
];


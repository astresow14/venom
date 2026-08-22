import { Router, type IRouter } from "express";
import healthRouter from "./health";
import venomRouter from "./venom";
import venomWorkspaceRouter from "./venom-workspace";
import venomAppPortfolioRouter from "./venom-app-portfolio";
import venomSopsRouter from "./venom-sops";
import venomCommunityRouter from "./venom-community";
import venomBuildRunsRouter, {
  startVenomBuildRunWorker,
} from "./venom-build-runs";
import venomProvisioningRouter, {
  startVenomProvisioningWorker,
} from "./venom-provisioning";
import venomOntologyRouter from "./venom-ontology";
import venomIdentityRouter from "./venom-identity";
import venomVoiceRouter from "./venom-voice";
import venomSharedWorkspacesRouter from "./venom-shared-workspaces";
import venomExportsRouter from "./venom-exports";
import venomFilesRouter from "./venom-files";
import venomSourceAlertsRouter from "./venom-source-alerts";
import { startVenomScheduledSourceSyncWorker } from "./venom-scheduled-sources";
import venomMasterRouter from "./venom-master";
import venomCanonRouter from "./venom-canon";
import venomAppSharingRouter from "./venom-app-sharing";
import venomBuildTemplatesRouter from "./venom-build-templates";
import venomAppAiRouter from "./venom-app-ai";
import venomKnowledgeMovesRouter from "./venom-knowledge-moves-router";
import venomBillingRouter from "./venom-billing-router";

const router: IRouter = Router();

router.use(healthRouter);
router.use(venomRouter);
router.use(venomBillingRouter);
router.use(venomVoiceRouter);
router.use(venomWorkspaceRouter);
router.use(venomOntologyRouter);
router.use(venomMasterRouter);
router.use(venomCanonRouter);
router.use(venomIdentityRouter);
router.use(venomAppPortfolioRouter);
router.use(venomAppSharingRouter);
router.use(venomAppAiRouter);
router.use(venomSopsRouter);
router.use(venomSharedWorkspacesRouter);
router.use(venomKnowledgeMovesRouter);
router.use(venomExportsRouter);
router.use(venomFilesRouter);
router.use(venomSourceAlertsRouter);
router.use(venomCommunityRouter);
router.use(venomBuildRunsRouter);
router.use(venomBuildTemplatesRouter);
router.use(venomProvisioningRouter);
startVenomBuildRunWorker();
startVenomProvisioningWorker();
startVenomScheduledSourceSyncWorker();

export default router;

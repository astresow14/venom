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
import { startVenomScheduledSourceSyncWorker } from "./venom-scheduled-sources";

const router: IRouter = Router();

router.use(healthRouter);
router.use(venomRouter);
router.use(venomVoiceRouter);
router.use(venomWorkspaceRouter);
router.use(venomOntologyRouter);
router.use(venomIdentityRouter);
router.use(venomAppPortfolioRouter);
router.use(venomSopsRouter);
router.use(venomSharedWorkspacesRouter);
router.use(venomCommunityRouter);
router.use(venomBuildRunsRouter);
router.use(venomProvisioningRouter);
startVenomBuildRunWorker();
startVenomProvisioningWorker();
startVenomScheduledSourceSyncWorker();

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import venomRouter from "./venom";
import venomWorkspaceRouter from "./venom-workspace";
import venomAppPortfolioRouter from "./venom-app-portfolio";

const router: IRouter = Router();

router.use(healthRouter);
router.use(venomRouter);
router.use(venomWorkspaceRouter);
router.use(venomAppPortfolioRouter);

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import venomRouter from "./venom";

const router: IRouter = Router();

router.use(healthRouter);
router.use(venomRouter);

export default router;

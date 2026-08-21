/**
 * venom-community.ts
 * Barrel: mounts all community sub-routers
 */

import { Router, type IRouter } from "express";
import profilesRouter from "./venom-community-profiles";
import threadsRouter from "./venom-community-threads";
import feedRouter from "./venom-community-feed";
import repliesRouter from "./venom-community-replies";
import votesRouter from "./venom-community-votes";
import reportsRouter from "./venom-community-reports";
import notificationsRouter from "./venom-community-notifications";

const router: IRouter = Router();

router.use(profilesRouter);
router.use(threadsRouter);
router.use(feedRouter);
router.use(repliesRouter);
router.use(votesRouter);
router.use(reportsRouter);
router.use(notificationsRouter);

export default router;

import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import venomAppAiGatewayRouter from "./routes/venom-app-ai-gateway";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import {
  MAX_API_JSON_BODY_BYTES,
  payloadTooLargeErrorHandler,
} from "./routes/venom-workspace-router";
import { handleStripeWebhook } from "./routes/venom-billing-router";

const app: Express = express();

const allowedOrigins = new Set<string>();
for (const value of [
  process.env.REPLIT_DEV_DOMAIN,
  process.env.REPLIT_EXPO_DEV_DOMAIN,
  ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
]) {
  if (!value) continue;
  allowedOrigins.add(
    value.startsWith("http://") || value.startsWith("https://")
      ? value
      : `https://${value}`,
  );
}

if (process.env.NODE_ENV !== "production") {
  allowedOrigins.add("http://localhost:8081");
  allowedOrigins.add("http://localhost:19006");
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);
// Stripe webhook: mounted ahead of the JSON parser because signature
// verification needs the exact raw bytes Stripe signed. It authenticates
// with that signature alone — Clerk is never involved.
app.post(
  "/api/venom/billing/webhook",
  express.raw({ type: () => true, limit: "1mb" }),
  (req, res, next) => {
    handleStripeWebhook(req, res).catch(next);
  },
);

app.use(express.json({ limit: MAX_API_JSON_BODY_BYTES }));
app.use(express.urlencoded({ extended: true }));

// The app AI gateway authenticates provisioned apps by their own runtime
// credentials, so it mounts BEFORE Clerk middleware: its bearer tokens are
// not Clerk tokens and must never reach Clerk parsing. Deliberately outside
// CORS allowances too — hosted apps call it server-to-server.
app.use("/api/app-gateway", venomAppAiGatewayRouter);

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

app.use(payloadTooLargeErrorHandler);

export default app;

import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
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
app.use(express.json({ limit: MAX_API_JSON_BODY_BYTES }));
app.use(express.urlencoded({ extended: true }));

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

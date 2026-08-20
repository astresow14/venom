import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";

export const MAX_VENOM_WORKSPACE_BYTES = 5 * 1024 * 1024;
export const MAX_API_JSON_BODY_BYTES = 6 * 1024 * 1024;

export type WorkspaceRecord = {
  state: unknown;
  revision: number;
  updatedAt: Date;
};

export type WorkspaceStore = {
  get(userId: string): Promise<WorkspaceRecord | undefined>;
  create(
    userId: string,
    state: unknown,
    updatedAt: Date,
  ): Promise<WorkspaceRecord | undefined>;
  update(
    userId: string,
    state: unknown,
    baseRevision: number,
    updatedAt: Date,
  ): Promise<WorkspaceRecord | undefined>;
};

type WorkspaceRouterOptions = {
  resolveUserId: (request: Request) => string | null | undefined;
  parseBody: (value: unknown) =>
    | {
        success: true;
        data: { state: unknown; baseRevision: number };
      }
    | {
        success: false;
        issues?: unknown;
      };
  store: WorkspaceStore;
};

function snapshot(row: WorkspaceRecord | undefined) {
  return row
    ? {
        state: row.state,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      }
    : {
        state: null,
        revision: 0,
        updatedAt: null,
      };
}

export function workspacePayloadBytes(state: unknown) {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

export function workspaceTooLargeResponse() {
  return {
    error: "Workspace is too large to sync",
    maxBytes: MAX_VENOM_WORKSPACE_BYTES,
  };
}

export function payloadTooLargeErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  const payloadError = error as {
    type?: string;
    status?: number;
    statusCode?: number;
  };
  if (
    payloadError.type === "entity.too.large" ||
    payloadError.status === 413 ||
    payloadError.statusCode === 413
  ) {
    response.status(413).json(workspaceTooLargeResponse());
    return;
  }
  next(error);
}

export function createVenomWorkspaceRouter({
  resolveUserId,
  parseBody,
  store,
}: WorkspaceRouterOptions): IRouter {
  const router: IRouter = Router();

  router.get("/venom/workspace", async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.json(snapshot(await store.get(userId)));
  });

  router.put("/venom/workspace", async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = parseBody(req.body);
    if (!parsed.success) {
      req.log?.warn(
        { validationErrors: parsed.issues },
        "Invalid Venom workspace save",
      );
      res.status(400).json({ error: "Invalid workspace" });
      return;
    }

    const { state, baseRevision } = parsed.data;
    const payloadBytes = workspacePayloadBytes(state);
    if (payloadBytes > MAX_VENOM_WORKSPACE_BYTES) {
      res.status(413).json(workspaceTooLargeResponse());
      return;
    }

    const now = new Date();
    const saved =
      baseRevision === 0
        ? await store.create(userId, state, now)
        : await store.update(userId, state, baseRevision, now);

    if (saved) {
      res.json(snapshot(saved));
      return;
    }

    res.status(409).json(snapshot(await store.get(userId)));
  });

  return router;
}
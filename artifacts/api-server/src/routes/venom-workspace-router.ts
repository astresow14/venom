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

/**
 * Optional bridge to the server-side ontology store. When present, the blob
 * is stored without knowledge clusters (they live in the store), accepted
 * saves are reconciled into the store, and every snapshot sent to a client
 * gets the stored knowledge re-injected.
 */
export type WorkspaceOntologyBridge = {
  /** Remove knowledge from the state before the blob is persisted. */
  strip(state: unknown): unknown;
  /** Run the lazy blob-to-store migration before the blob is overwritten. */
  ensureOwner(userId: string): Promise<unknown>;
  /**
   * Reconcile an accepted save into the store. Returns the response state
   * (knowledge re-injected). Only called after the optimistic-concurrency
   * write succeeded, so a stale snapshot can never rewrite the store.
   */
  absorb(userId: string, state: unknown): Promise<unknown>;
  /** Re-inject stored knowledge into a stored blob state. */
  hydrate(userId: string, state: unknown): Promise<unknown>;
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
  ontology?: WorkspaceOntologyBridge;
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
  ontology,
}: WorkspaceRouterOptions): IRouter {
  const router: IRouter = Router();

  async function hydratedSnapshot(
    userId: string,
    record: WorkspaceRecord | undefined,
  ) {
    if (!record || !ontology) return snapshot(record);
    return {
      state: await ontology.hydrate(userId, record.state),
      revision: record.revision,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  router.get("/venom/workspace", async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.json(await hydratedSnapshot(userId, await store.get(userId)));
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
    // Knowledge lives in the ontology store, so it no longer counts against
    // the snapshot size cap.
    const stateToStore = ontology ? ontology.strip(state) : state;
    const payloadBytes = workspacePayloadBytes(stateToStore);
    if (payloadBytes > MAX_VENOM_WORKSPACE_BYTES) {
      res.status(413).json(workspaceTooLargeResponse());
      return;
    }

    // Import any pre-store knowledge out of the current blob before this
    // save overwrites it with a stripped state.
    if (ontology) await ontology.ensureOwner(userId);

    const now = new Date();
    const saved =
      baseRevision === 0
        ? await store.create(userId, stateToStore, now)
        : await store.update(userId, stateToStore, baseRevision, now);

    if (saved) {
      if (!ontology) {
        res.json(snapshot(saved));
        return;
      }
      res.json({
        state: await ontology.absorb(userId, state),
        revision: saved.revision,
        updatedAt: saved.updatedAt.toISOString(),
      });
      return;
    }

    res
      .status(409)
      .json(await hydratedSnapshot(userId, await store.get(userId)));
  });

  return router;
}
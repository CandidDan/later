"use client";

import { useCallback, useEffect, useReducer, useState } from "react";

import {
  INITIAL_CONSOLE_STATE,
  researchConsoleReducer,
  type ConsoleState,
} from "../../lib/research/console-state";
import type { CaptureContext, RevealedRun } from "../../lib/research/types";
import { browserSupabaseClient } from "../../lib/supabase/browser";

import {
  MAGIC_LINK_FAILURE_MESSAGE,
  requestResearchMagicLink,
  restoreResearchAccessToken,
} from "./auth";
import {
  EmptyPanel,
  ErrorPanel,
  MagicLinkSentPanel,
  RecallPanel,
  RevealPanel,
  SignInPanel,
} from "./views";

const UNAVAILABLE = "The research console is unavailable right now.";

async function call(
  token: string,
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.status === 401) {
    throw new Error("unauthorized");
  }

  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "request_failed");
  }

  return payload;
}

function checked(form: FormData, field: string): boolean {
  return form.get(field) !== null;
}

function text(form: FormData, field: string): string {
  const value = form.get(field);

  return typeof value === "string" ? value : "";
}

export default function ResearchConsole() {
  const [state, dispatch] = useReducer(researchConsoleReducer, INITIAL_CONSOLE_STATE);
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  useEffect(() => {
    restoreResearchAccessToken(browserSupabaseClient().auth)
      .then((active) => {
        setToken(active);

        if (!active) {
          dispatch({ type: "signed_out", message: null });
        }
      })
      .catch(() => dispatch({ type: "failed", message: UNAVAILABLE }));
  }, []);

  const load = useCallback(async (active: string) => {
    dispatch({ type: "loading" });

    try {
      const payload = await call(active, "/api/research/next");

      if (payload.phase === "reveal") {
        dispatch({
          type: "resumed",
          capture: payload.capture as CaptureContext,
          runs: (payload.runs as RevealedRun[]) ?? [],
        });
        return;
      }

      dispatch({
        type: "loaded",
        capture: (payload.capture as CaptureContext | undefined) ?? undefined,
      });
    } catch (error) {
      dispatch(
        (error as Error).message === "unauthorized"
          ? { type: "signed_out", message: "That session cannot use the research console." }
          : { type: "failed", message: UNAVAILABLE },
      );
    }
  }, []);

  useEffect(() => {
    if (token && state.phase === "loading") {
      void load(token);
    }
  }, [token, state.phase, load]);

  const signIn = useCallback(async (form: FormData) => {
    setPending(true);
    setLinkSent(false);

    let accepted = false;

    try {
      accepted = await requestResearchMagicLink(
        browserSupabaseClient().auth,
        text(form, "email"),
        window.location.origin,
      );
    } catch {
      accepted = false;
    }

    if (accepted) {
      dispatch({ type: "signed_out", message: null });
      setLinkSent(true);
    } else {
      dispatch({ type: "signed_out", message: MAGIC_LINK_FAILURE_MESSAGE });
    }

    setPending(false);
  }, []);

  const submitRecall = useCallback(
    (capture: CaptureContext) => (form: FormData) => {
      if (!token) {
        return;
      }

      setPending(true);
      const recallStatus = text(form, "recallStatus");
      const remembered = text(form, "rememberedInterest").trim();

      // Two round trips on purpose. The recall answer is committed by the first, and only a
      // separate request can return what the model said — a single call could not prove which
      // happened first.
      void call(token, "/api/research/recall", {
        method: "POST",
        body: {
          captureId: capture.captureId,
          recallStatus,
          rememberedInterest:
            recallStatus === "cannot_remember" || remembered === "" ? null : remembered,
        },
      })
        .then(() => {
          dispatch({ type: "recall_stored" });
          return call(
            token,
            `/api/research/reveal?captureId=${encodeURIComponent(capture.captureId)}`,
          );
        })
        .then((payload) =>
          dispatch({ type: "revealed", runs: (payload.runs as RevealedRun[]) ?? [] }),
        )
        .catch((error: Error) =>
          dispatch(
            error.message === "unauthorized"
              ? { type: "signed_out", message: "That session cannot use the research console." }
              : { type: "failed", message: UNAVAILABLE },
          ),
        )
        .finally(() => setPending(false));
    },
    [token],
  );

  const submitRating = useCallback(
    (form: FormData) => {
      if (!token) {
        return;
      }

      setPending(true);
      const evaluationId = text(form, "evaluationId");
      const notes = text(form, "notes").trim();

      void call(token, "/api/research/rating", {
        method: "POST",
        body: {
          evaluationId,
          intentAccuracy: text(form, "intentAccuracy"),
          stillInterested: checked(form, "stillInterested"),
          consumedBeforeEvaluation: checked(form, "consumedBeforeEvaluation"),
          notes: notes === "" ? null : notes,
        },
      })
        .then(() => dispatch({ type: "rated", evaluationId }))
        .catch((error: Error) =>
          dispatch(
            error.message === "unauthorized"
              ? { type: "signed_out", message: "That session cannot use the research console." }
              : { type: "failed", message: UNAVAILABLE },
          ),
        )
        .finally(() => setPending(false));
    },
    [token],
  );

  return renderConsole(state, {
    pending,
    linkSent,
    signIn,
    restartSignIn: () => {
      setLinkSent(false);
      dispatch({ type: "signed_out", message: null });
    },
    submitRecall,
    submitRating,
    retry: () => dispatch({ type: "loading" }),
  });
}

function renderConsole(
  state: ConsoleState,
  actions: {
    pending: boolean;
    linkSent: boolean;
    signIn(form: FormData): void;
    restartSignIn(): void;
    submitRecall(capture: CaptureContext): (form: FormData) => void;
    submitRating(form: FormData): void;
    retry(): void;
  },
) {
  switch (state.phase) {
    case "signed_out":
      return actions.linkSent ? (
        <MagicLinkSentPanel onStartOver={actions.restartSignIn} />
      ) : (
        <SignInPanel message={state.message} pending={actions.pending} onSubmit={actions.signIn} />
      );

    case "recall":
    case "recorded":
      return (
        <RecallPanel
          capture={state.capture}
          pending={actions.pending || state.phase === "recorded"}
          onSubmit={actions.submitRecall(state.capture)}
        />
      );

    case "reveal":
      return (
        <RevealPanel
          capture={state.capture}
          runs={state.runs}
          rated={state.rated}
          pending={actions.pending}
          onRate={actions.submitRating}
        />
      );

    case "empty":
      return <EmptyPanel />;

    case "error":
      return <ErrorPanel message={state.message} onRetry={actions.retry} />;

    case "loading":
      return <p className="text-base text-zinc-500">Loading…</p>;
  }
}

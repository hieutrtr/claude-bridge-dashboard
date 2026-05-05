// T5 — tRPC v11 base. Single shared `t` instance so every router uses the
// same transformer, error formatter, and context type.
//
// Context is empty for the spike — Phase 4 (auth) will add `user`,
// `requireAuth`, and `requireRole` middlewares per ARCHITECTURE.md §6.

import { initTRPC } from "@trpc/server";

export type Context = Record<string, never>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

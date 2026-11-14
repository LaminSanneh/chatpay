import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { ChatError } from '../core/errors';
import { correlationMiddleware, CORRELATION_RESPONSE_HEADER } from '../observability/correlation';
import { isDependencyOutage } from '../messaging/retry-policy';
import type { TokenVerifier } from '../core/ports';
import type { ChatService } from '../core/chat-service';
import type { Identity } from '../core/types';

export interface HttpDeps {
  chat: ChatService;
  verifier: TokenVerifier;
  corsOrigins: string[];
  /** Readiness probe: resolves when the dependencies the service needs (the database) are reachable. */
  ready?: () => Promise<unknown>;
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

const idOf = (res: Response) => res.locals.identity as Identity;
const param = (req: Request, name: string) => String(req.params[name]);

export function createHttpApp({ chat, verifier, corsOrigins, ready }: HttpDeps) {
  const app = express();
  app.use(correlationMiddleware);                                                   // first: every log line and every response of this request carries the id
  app.use(cors({ origin: corsOrigins, exposedHeaders: [CORRELATION_RESPONSE_HEADER] }));   // browsers may read it, to quote it in a bug report
  app.use(express.json({ limit: '32kb' }));

  // Liveness: the process is up (stays 200 during a database outage, so an orchestrator does not restart a healthy service).
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  // Readiness: it can actually serve requests (503 while the database is unreachable).
  app.get('/ready', async (_req, res) => {
    try { await ready?.(); res.json({ status: 'ready' }); }
    catch (err) { res.status(503).json({ status: 'unavailable', reason: (err as Error).message }); }
  });

  const api = express.Router();

  // Authenticate every /api request and make sure the caller exists in the user directory.
  api.use(async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return void res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing bearer token' });
    let identity: Identity;
    try {
      identity = await verifier.verify(token);
    } catch {
      return void res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Invalid or expired token' });
    }
    try {
      await chat.touchUser(identity);          // a database failure here is an outage (503), not a bad token
    } catch (err) {
      return next(err);
    }
    res.locals.identity = identity;
    next();
  });

  // ---- users
  api.get('/me', wrap(async (_req, res) => { res.json(await chat.touchUser(idOf(res))); }));
  api.get('/users', wrap(async (req, res) => {
    const q = z.string().max(50).default('').parse(req.query.q ?? '');
    res.json(await chat.searchUsers(q, idOf(res).userId));
  }));

  // ---- rooms
  api.get('/rooms', wrap(async (_req, res) => { res.json(await chat.listRooms(idOf(res).userId)); }));

  api.get('/rooms/public', wrap(async (req, res) => {
    const q = z.string().max(80).default('').parse(req.query.q ?? '');
    res.json(await chat.listPublicGroups(q));
  }));

  api.post('/rooms', wrap(async (req, res) => {
    const body = z.object({
      name: z.string(),
      visibility: z.enum(['public', 'private']).optional(),
      inviteeIds: z.array(z.string().min(1)).max(50).optional(),
    }).parse(req.body);
    res.status(201).json(await chat.createGroup(idOf(res).userId, body));
  }));

  api.post('/rooms/direct', wrap(async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    res.json(await chat.getOrCreateDirect(idOf(res).userId, userId));
  }));

  api.post('/rooms/:id/join', wrap(async (req, res) => {
    res.json(await chat.joinGroup(idOf(res).userId, param(req, 'id')));
  }));

  api.post('/rooms/:id/leave', wrap(async (req, res) => {
    await chat.leaveGroup(idOf(res).userId, param(req, 'id'));
    res.status(204).end();
  }));

  api.post('/rooms/:id/invites', wrap(async (req, res) => {
    const { userIds } = z.object({ userIds: z.array(z.string().min(1)).min(1).max(50) }).parse(req.body);
    res.status(201).json(await chat.inviteToGroup(idOf(res).userId, param(req, 'id'), userIds));
  }));

  api.get('/rooms/:id/messages', wrap(async (req, res) => {
    const q = z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    res.json(await chat.history(idOf(res).userId, param(req, 'id'), q));
  }));

  // Not used by the web app (it sends over the socket); kept for bots, scripts and HTTP-only clients.
  api.post('/rooms/:id/messages', wrap(async (req, res) => {
    const { text, mentions } = z.object({ text: z.string(), mentions: z.array(z.string()).max(50).optional() }).parse(req.body);
    res.status(201).json(await chat.sendText(idOf(res).userId, param(req, 'id'), text, mentions));
  }));

  api.post('/rooms/:id/read', wrap(async (req, res) => {
    const { upTo } = z.object({ upTo: z.number().int().nonnegative().optional() }).parse(req.body ?? {});
    await chat.markRead(idOf(res).userId, param(req, 'id'), upTo);
    res.status(204).end();
  }));

  // ---- invites
  api.get('/invites', wrap(async (_req, res) => { res.json(await chat.listInvites(idOf(res).userId)); }));
  api.post('/invites/:id/accept', wrap(async (req, res) => {
    res.json(await chat.respondToInvite(idOf(res).userId, param(req, 'id'), true));
  }));
  api.post('/invites/:id/decline', wrap(async (req, res) => {
    await chat.respondToInvite(idOf(res).userId, param(req, 'id'), false);
    res.status(204).end();
  }));

  app.use('/api', api);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ChatError) return void res.status(err.status).json({ code: err.code, message: err.message });
    if (err instanceof z.ZodError) return void res.status(400).json({ code: 'VALIDATION_FAILED', message: err.issues[0]?.message ?? 'invalid request' });
    if (isDependencyOutage(err)) {
      console.warn(`[http] ${_req.method} ${_req.path}: a dependency is unavailable (${(err as Error).message})`);
      return void res.set('Retry-After', '5').status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, please retry shortly' });
    }
    console.error('[http] unhandled', err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
  });

  return app;
}

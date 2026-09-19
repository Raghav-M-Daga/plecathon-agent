/**
 * Vercel serverless entry point for the agent contract.
 *
 * Mirrors the routes in agent/server.js so the deployed app behaves like the
 * local one:
 *   POST /agent/messages   { sessionId, text }  ->  { parts: Part[] }
 *   POST /agent/reset      { sessionId }        ->  { ok: true }
 *   GET  /health           { ok: true }
 *
 * The chat page itself (chat/) is served by Vercel as static files; see
 * vercel.json for the rewrites that send the routes above here.
 *
 * NOTE: session state lives in memory (agent/session.js). A warm serverless
 * instance keeps it between turns, but a cold start loses it.
 */

import { respond } from '../agent/agent.js';
import { getSession, resetSession } from '../agent/session.js';

/** The evaluator gives up at 45s; answer with an error before that so the failure is visible. */
const TURN_DEADLINE_MS = 40_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === 'GET' && pathname.endsWith('/health')) return json(res, 200, { ok: true });
    if (req.method === 'GET' && pathname.endsWith('/envcheck')) {
      return json(res, 200, { keys: Object.keys(process.env).filter((k) => /LLM|PLEC|AGENT/.test(k)).sort(), llm: (process.env.LLM_API_KEY || '').length, sandbox: (process.env.PLEC_SANDBOX_KEY || '').length, model: process.env.LLM_MODEL || null, base: process.env.LLM_BASE_URL || null });
    }
    if (req.method === 'POST' && pathname.endsWith('/messages')) return await handleMessage(req, res);
    if (req.method === 'POST' && pathname.endsWith('/reset')) return await handleReset(req, res);
    return json(res, 404, { error: 'not_found', message: `No route ${req.method} ${pathname}` });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'server_error', message: err?.message ?? String(err) });
  }
}

async function handleMessage(req, res) {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: 'bad_json', message: 'Send a JSON body: { "sessionId": "...", "text": "..." }' });
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!sessionId) return json(res, 400, { error: 'session_required', message: 'sessionId must be a non-empty string' });
  if (!text) return json(res, 400, { error: 'text_required', message: 'text must be a non-empty string' });

  const startedAt = Date.now();
  let parts;
  try {
    parts = await withDeadline(respond({ sessionId, text, session: getSession(sessionId) }), TURN_DEADLINE_MS);
  } catch (err) {
    const timedOut = err?.code === 'DEADLINE';
    console.error(`[turn ${sessionId.slice(0, 8)}] failed after ${Date.now() - startedAt}ms:`, timedOut ? err.message : err);
    return json(res, timedOut ? 504 : 500, { error: timedOut ? 'agent_timeout' : 'agent_error', message: err?.message ?? String(err) });
  }

  const clean = Array.isArray(parts) ? parts.filter(isPart) : [];
  if (clean.length === 0) {
    return json(res, 500, { error: 'no_parts', message: 'respond() returned no valid parts. See docs/contract.md for the shapes.' });
  }
  console.log(`[turn ${sessionId.slice(0, 8)}] ${Date.now() - startedAt}ms  "${text.slice(0, 60)}" -> ${clean.map((p) => p.kind).join(',')}`);
  return json(res, 200, { parts: clean });
}

async function handleReset(req, res) {
  const body = await readJson(req);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) return json(res, 400, { error: 'session_required', message: 'sessionId must be a non-empty string' });
  resetSession(sessionId);
  return json(res, 200, { ok: true });
}

function isPart(part) {
  if (!part || typeof part !== 'object') return false;
  switch (part.kind) {
    case 'text': return typeof part.text === 'string';
    case 'card': return typeof part.title === 'string' && Array.isArray(part.photoUrls);
    case 'link': return typeof part.label === 'string' && typeof part.url === 'string';
    case 'image': return typeof part.url === 'string';
    default: return false;
  }
}

/** Vercel may have parsed the body already; fall back to reading the stream. */
function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve(null); }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`The agent took more than ${ms / 1000}s to reply`);
      err.code = 'DEADLINE';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

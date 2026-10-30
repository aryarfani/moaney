import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { answerQuestion } from '../domain/ask.js';
import { overview, PERIODS } from '../domain/reports.js';
import { today } from '../domain/time.js';

// Authenticated routes (session cookie + CSRF), mounted under /api/v1.
export function reportsRouter(db: Db): Router {
  const r = Router();
  r.get('/reports/overview', (req, res) => {
    const q = z.object({
      period: z.enum(['daily', 'weekly', 'monthly', 'yearly']).default('monthly'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today()),
    }).parse(req.query);
    if (!PERIODS.includes(q.period)) throw new Error('bad period');
    res.json(overview(db, q.period, q.date));
  });
  r.post('/ask', (req, res) => {
    const { question } = z.object({ question: z.string().trim().min(1).max(500) }).parse(req.body);
    res.json(answerQuestion(db, question));
  });
  return r;
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { capture, type Rule, type RulesView } from '../api-capture';
import { useStore } from '../store';
import './capture.css';

export function RulesPage() {
  const { category, reload } = useStore();
  const [view, setView] = useState<RulesView | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await capture.rules());
    } catch {
      setError('Could not load. Check your connection.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await Promise.all([load(), reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    }
  }

  const catName = (r: Rule) => category(r.categoryId)?.name ?? 'Unknown category';
  const pattern = (r: Rule) => r.pattern.replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <>
      <div className="cap-head">
        <Link to="/settings" className="cap-back" aria-label="Back">←</Link>
        <h1 className="cap-title">Rules</h1>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}

      <h2>Suggested from your corrections</h2>
      {view && view.suggested.length === 0 && <div className="cap-card cap-empty">No suggestions yet. Moaney suggests a rule after you file the same merchant under the same category three times.</div>}
      {view?.suggested.map((r) => (
        <div key={r.id} className="cap-card">
          <div style={{ fontSize: 14, lineHeight: 1.4 }}>When a payment is from <b>{pattern(r)}</b>, file it under <span className="cap-tag">{catName(r)}</span></div>
          <div className="muted small">You chose this {r.chosen} times. It would apply to new notifications automatically.</div>
          <div className="cap-actions">
            <button className="btn grow" onClick={() => void run(() => capture.approveRule(r.id))}>Approve</button>
            <button className="btn ghost" onClick={() => void run(() => capture.rejectRule(r.id))}>Not now</button>
          </div>
        </div>
      ))}

      <h2>Active rules</h2>
      {view && view.active.length === 0 && <div className="cap-card cap-empty">No active rules.</div>}
      {view && view.active.length > 0 && (
        <div className="cap-list">
          {view.active.map((r) => (
            <div key={r.id} className="cap-row">
              <span className="grow"><b>{pattern(r)}</b> → {catName(r)}</span>
              <span className="muted small">{r.uses} {r.uses === 1 ? 'use' : 'uses'}</span>
              <button className="cap-sw" role="switch" aria-checked aria-label={`Rule for ${pattern(r)} is on`} onClick={() => void run(() => capture.setRule(r.id, 'off'))} />
            </div>
          ))}
        </div>
      )}

      {view && view.off.length > 0 && (
        <>
          <h2>Switched off</h2>
          <div className="cap-list">
            {view.off.map((r) => (
              <div key={r.id} className="cap-row">
                <span className="grow muted"><b>{pattern(r)}</b> → {catName(r)}</span>
                <button className="cap-sw" role="switch" aria-checked={false} aria-label={`Rule for ${pattern(r)} is off`} onClick={() => void run(() => capture.setRule(r.id, 'active'))} />
              </div>
            ))}
          </div>
        </>
      )}
      <div className="cap-note">Rules never apply until you approve them, and you can switch any of them off.</div>
    </>
  );
}

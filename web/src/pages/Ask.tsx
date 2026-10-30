import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { reportsApi, type Answer } from '../api-reports';
import './reports.css';

const STARTERS = ['How much did I spend this month?', 'Top 5 merchants this month', 'Compare spending with last month'];

export function AskPage() {
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    setAsked(q);
    try {
      setAnswer(await reportsApi.ask(q));
      setText('');
    } catch (e) {
      setAnswer(null);
      setError(e instanceof ApiError ? e.message : 'Could not answer that. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="row">
        <Link to="/reports" className="btn ghost" aria-label="Back" style={{ width: 44, minHeight: 44, padding: 0 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </Link>
        <h1 style={{ fontSize: 22 }}>Ask Moaney</h1>
      </header>

      {asked && <div className="ask-q">{asked}</div>}
      {error && <div className="notice" role="alert">{error}</div>}

      {answer && (
        <section className="ask-a" aria-live="polite" aria-label="Answer">
          <div style={{ fontSize: 16, lineHeight: 1.45 }}>{answer.answer}</div>
          {answer.facts.length > 0 && (
            <div>{answer.facts.map((f) => <div key={f.label} className="kv"><span className="muted">{f.label}</span><b className="num" style={{ textAlign: 'right' }}>{f.value}</b></div>)}</div>
          )}
          <div className="muted small">{answer.note}</div>
        </section>
      )}

      <div className="chips" role="group" aria-label="Suggestions">
        {(answer?.followUps.length ? answer.followUps : STARTERS).map((s) => (
          <button key={s} type="button" className="chip" disabled={busy} onClick={() => void ask(s)}>{s}</button>
        ))}
      </div>

      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your money" maxLength={500} aria-label="Your question" />
        <button className="btn" disabled={busy || !text.trim()} aria-label="Send">Send</button>
      </form>
      <div className="muted small" style={{ padding: '0 4px' }}>Answers are calculated from your records. Moaney does not guess or estimate.</div>
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { capture, type SourcesView } from '../api-capture';
import { useStore } from '../store';
import './capture.css';
import './desk-settings.css';

const INGEST_URL = 'https://moaney.arfani.my.id/api/v1/capture/notifications';
const INITIALS: Record<string, string> = { gopay: 'GP', mybca: 'BCA', jago: 'Jg' };

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SourcesPage() {
  const { wallets, reload } = useStore();
  const [view, setView] = useState<SourcesView | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pairing, setPairing] = useState(false);
  const [deviceName, setDeviceName] = useState('My phone');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [newIgnore, setNewIgnore] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await capture.sources());
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

  const device = view?.devices[0];
  const real = wallets.filter((w) => w.countsTowardTotal && !w.archived);
  const copyThen = async (text: string, what: string) => setNote((await copy(text)) ? `${what} copied` : 'Could not copy. Select the text and copy it by hand.');

  return (
    <>
      <div className="cap-head">
        <Link to="/settings" className="cap-back" aria-label="Back">←</Link>
        <h1 className="cap-title">Notification sources</h1>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      {note && <div className="notice" role="status">{note}</div>}

      {issued ? (
        <section className="cap-card" aria-label="Phone paired">
          <b>{issued.name} is paired</b>
          <div className="cap-note" style={{ padding: 0 }}>This token is shown once. Copy it into your automation app now.</div>
          <div className="muted small">Address</div>
          <div className="cap-secret">{INGEST_URL}</div>
          <button className="btn ghost" onClick={() => void copyThen(INGEST_URL, 'Address')}>Copy address</button>
          <div className="muted small">Token</div>
          <div className="cap-secret">{issued.token}</div>
          <button className="btn ghost" onClick={() => void copyThen(issued.token, 'Token')}>Copy token</button>
          <div className="cap-note" style={{ padding: 0 }}>
            In MacroDroid or Tasker, trigger on notifications from GoPay, myBCA and Jago. Add an HTTP POST to the address above with the header
            {' '}<b>Authorization: Bearer</b> followed by the token, content type JSON, and a body like
            {' '}<b>{'{"app":"gopay","title":"…","text":"…"}'}</b> using the app name, notification title and notification text.
            OTPs and security messages are dropped before they are stored.
          </div>
          <button className="btn" onClick={() => setIssued(null)}>Done</button>
        </section>
      ) : device ? (
        <section className="cap-card" aria-label="Phone">
          <div className="row between">
            <div>
              <b>{device.name}</b>
              <div className="muted small">Last notification {ago(device.lastSeenAt)}</div>
            </div>
            <button className="cap-sw" role="switch" aria-checked={!view!.paused} aria-label="Capture on" onClick={() => void run(() => capture.settings({ paused: !view!.paused }))} />
          </div>
          <div className="row">
            <span className={`cap-tag ${view!.paused ? 'warn' : 'good'}`}>{view!.paused ? 'Paused' : 'Capturing'}</span>
            <span className="muted small">{view!.paused ? 'New notifications are ignored' : 'Notifications go to Close the day'}</span>
          </div>
        </section>
      ) : view && (
        <section className="cap-card" aria-label="Pair a phone">
          <b>No phone paired yet</b>
          <div className="cap-note" style={{ padding: 0 }}>Pair a phone to send bank and e-wallet notifications here for review.</div>
          {pairing ? (
            <form className="field" onSubmit={(e) => { e.preventDefault(); void run(async () => { const d = await capture.pairDevice(deviceName.trim() || 'My phone'); setIssued({ name: d.name, token: d.token }); setPairing(false); }); }}>
              <label htmlFor="dn">Phone name</label>
              <input id="dn" className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={60} />
              <div className="cap-actions" style={{ marginTop: 8 }}>
                <button className="btn grow">Create token</button>
                <button type="button" className="btn ghost" onClick={() => setPairing(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="btn" onClick={() => setPairing(true)}>Pair a phone</button>
          )}
        </section>
      )}

      <h2>Apps allowed to send</h2>
      <div className="cap-list">
        {view?.apps.map((a) => (
          <div key={a.id} className="cap-row src-row" style={{ flexWrap: 'wrap' }}>
            <span className="cap-tile" aria-hidden="true">{INITIALS[a.app] ?? a.label.slice(0, 2)}</span>
            <span className="grow">
              <b style={{ display: 'block' }}>{a.label}</b>
              <span className="muted small">
                {a.total === 0 ? 'Waiting for the first samples'
                  : `${a.confirmed} of ${a.reviewed} reviewed were confirmed · last ${ago(a.lastAt)}`}
              </span>
            </span>
            <span className={`cap-tag ${a.hasParser ? '' : 'warn'}`}>{a.hasParser ? 'Review first' : 'No parser yet'}</span>
            <div className="field" style={{ width: '100%' }}>
              <label htmlFor={`w${a.id}`}>Counts as wallet</label>
              <select id={`w${a.id}`} className="input" value={a.walletId ?? ''} onChange={(e) => void run(() => capture.mapWallet(a.id, Number(e.target.value) || null))}>
                <option value="">Not set</option>
                {real.map((w) => <option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>
      <div className="cap-note">Every notification waits for your OK in Close the day. Codes, OTPs and security messages are dropped before they are stored.</div>

      <h2>Your names, for spotting transfers between your own accounts</h2>
      <div className="cap-card">
        <div className="chips">
          {view?.names.map((n) => (
            <span key={n} className="cap-tag" style={{ height: 32, fontSize: 12, gap: 6 }}>
              {n}
              <button className="cap-link" style={{ minHeight: 0, padding: 0 }} aria-label={`Remove ${n}`} onClick={() => void run(() => capture.settings({ removeName: n }))}>×</button>
            </span>
          ))}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) void run(async () => { await capture.settings({ addName: newName.trim() }); setNewName(''); }); }}>
          <input className="input grow" aria-label="Add a name" placeholder="Name as it appears in the bank app" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} />
          <button className="btn ghost" disabled={!newName.trim()}>Add</button>
        </form>
      </div>

      <h2>Ignored words</h2>
      <div className="cap-card">
        <div className="muted small">Notifications containing any of these are dropped and never show up in Close the day.</div>
        <div className="chips">
          {view?.ignore.map((n) => (
            <span key={n} className="cap-tag" style={{ height: 32, fontSize: 12, gap: 6 }}>
              {n}
              <button className="cap-link" style={{ minHeight: 0, padding: 0 }} aria-label={`Remove ${n}`} onClick={() => void run(() => capture.settings({ removeIgnore: n }))}>×</button>
            </span>
          ))}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (newIgnore.trim().length >= 2) void run(async () => { await capture.settings({ addIgnore: newIgnore.trim() }); setNewIgnore(''); }); }}>
          <input className="input grow" aria-label="Add an ignored word" placeholder="e.g. GoPay Coins" value={newIgnore} onChange={(e) => setNewIgnore(e.target.value)} maxLength={80} />
          <button className="btn ghost" disabled={newIgnore.trim().length < 2}>Add</button>
        </form>
      </div>

      {device && !issued && (
        <div className="cap-actions">
          <button className="btn ghost grow" onClick={() => void run(() => capture.settings({ paused: !view!.paused }))}>{view!.paused ? 'Resume capture' : 'Pause capture'}</button>
          <button className="btn danger grow" onClick={() => { if (confirm('Remove this phone? Its token stops working.')) void run(() => capture.removeDevice(device.id)); }}>Remove phone</button>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { planApi, type DataStatus } from '../api-plan';
import { useStore } from '../store';
import { BackHeader } from './Settings';
import './plan.css';
import './desk-settings.css';

const RETENTION = [7, 30, 90] as const;

function sizeLabel(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

async function downloadExport() {
  const text = await api.exportCsv();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = 'moaney-transactions.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function DataPage() {
  const { signOut } = useStore();
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    planApi.dataStatus().then(setStatus).catch(() => setError('Could not load backup status.'));
  }, []);

  async function setRetention(days: number) {
    const before = status;
    setStatus(status && { ...status, retentionDays: days });
    try { await planApi.setValue('capture.retentionDays', String(days)); } catch { setStatus(before); setError('Could not save that setting.'); }
  }

  const when = status?.backup ? new Date(status.backup.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : '';

  return (
    <>
      <BackHeader to="/settings" title="Data and security" />
      {error && <div className="notice" role="alert">{error}</div>}
      <div className="data-cols">
      <div className="data-group">
      <h2>Your data</h2>
      <div className="card flush">
        <div className="item plain">
          <span className="grow"><b>Daily backup</b><div className="sub">{status === null ? 'Checking…' : status.backup ? `${when} · ${sizeLabel(status.backup.size)}` : 'No backup yet. The first one runs after 03:00.'}</div></span>
          <span className={`tag ${status?.backup ? 'good' : 'warn'}`}>{status?.backup ? 'OK' : 'None'}</span>
        </div>
        <button className="item" onClick={() => void downloadExport()}><span className="grow"><b>Export transactions</b><div className="sub">Download everything as CSV</div></span><span className="tag">CSV</span></button>
        <Link to="/import" className="item"><span className="grow"><b>Import transactions (CSV)</b><div className="sub">Use the template to bring in old data</div></span><span className="chev" aria-hidden="true">›</span></Link>
        <div className="item plain">
          <span className="grow"><b>Keep notification text for</b><div className="sub">The original wording is deleted after this many days</div></span>
          <div className="seg" role="group" aria-label="Retention in days" style={{ width: 150 }}>
            {RETENTION.map((d) => <button key={d} type="button" aria-pressed={status?.retentionDays === d} onClick={() => void setRetention(d)}>{d}</button>)}
          </div>
        </div>
      </div>

      </div>
      <div className="data-group">
      <h2>Account</h2>
      <div className="card flush">
        <button className="item" onClick={() => void signOut()}><span className="grow"><b>Sign out</b></span></button>
      </div>
      </div>
      </div>
      <div className="muted small" style={{ padding: '0 4px', lineHeight: 1.45 }}>Connected apps, language and changing the password are not available yet.</div>
    </>
  );
}

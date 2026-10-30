import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ImportPreview } from '../api';
import { useStore } from '../store';

export function ImportPage() {
  const { reload } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [createNew, setCreateNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(''); setResult(null); setPreview(null); setFileName(file.name); setBusy(true);
    try {
      setPreview(await api.importPreview(await file.text()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read that file');
    }
    setBusy(false);
  }

  async function apply() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      setResult(await api.importApply(preview.id, createNew));
      setPreview(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Import failed');
    }
    setBusy(false);
  }

  async function template() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([await api.template()], { type: 'text/csv' }));
    a.download = 'moaney-transactions-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const needsNames = !!preview && (preview.newWallets.length > 0 || preview.newCategories.length > 0);

  return (
    <>
      <h1>Import history</h1>
      <div className="muted">Upload a CSV. <button className="chip" style={{ minHeight: 32 }} onClick={() => void template()}>Download template</button></div>
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <button className="btn" onClick={() => input.current?.click()} disabled={busy}>{fileName ? 'Choose another file' : 'Choose transactions.csv'}</button>
      {error && <div className="err" role="alert">{error}</div>}

      {result && (
        <div className="card" role="status">
          <b>Imported {result.imported} entries.</b>{result.skipped > 0 && <div className="muted small">{result.skipped} skipped.</div>}
          <div style={{ marginTop: 8 }}><Link to="/history">See history</Link></div>
        </div>
      )}

      {preview && (
        <>
          <div className="card">
            <b>{fileName}</b>
            <div className="muted small">Checked. Nothing is saved yet.</div>
            <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <Stat n={preview.ready} label="to import" />
              <Stat n={preview.duplicates} label="already saved" />
              <Stat n={preview.problems.length} label="problems" />
            </div>
            {preview.dateFrom && <div className="muted small" style={{ marginTop: 8 }}>{preview.dateFrom} to {preview.dateTo}</div>}
          </div>

          <div className="card" style={{ fontSize: 13 }}>
            <b>Rows without a wallet</b>
            <div className="muted">They go into “Before Moaney”: shown in reports and Log again, but never change a real balance.</div>
          </div>

          {preview.categoriesInFile.length > 0 && (
            <div className="chips" aria-label="Categories in the file">{preview.categoriesInFile.map((c) => <span key={c} className="chip" style={{ cursor: 'default', minHeight: 30 }}>{c}</span>)}</div>
          )}

          {needsNames && (
            <div className="notice">
              <b>New names: {[...preview.newWallets.map((n) => `wallet ${n}`), ...preview.newCategories.map((c) => `category ${c.name}`)].join(', ')}</b>
              <div className="seg" role="group" aria-label="New names" style={{ marginTop: 8 }}>
                <button aria-pressed={createNew} onClick={() => setCreateNew(true)}>Create them</button>
                <button aria-pressed={!createNew} onClick={() => setCreateNew(false)}>Skip those rows</button>
              </div>
            </div>
          )}

          {preview.problems.length > 0 && (
            <div className="card">
              <b>Problems ({preview.problems.length})</b>
              {preview.problems.slice(0, 20).map((p) => <div key={p.line} className="muted small">Row {p.line}: {p.reason}</div>)}
              {preview.problems.length > 20 && <div className="muted small">…and {preview.problems.length - 20} more. Those rows are skipped.</div>}
            </div>
          )}

          <button className="btn" onClick={apply} disabled={busy || preview.ready === 0}>Import {preview.ready} entries</button>
        </>
      )}
    </>
  );
}

const Stat = ({ n, label }: { n: number; label: string }) => (
  <div style={{ flex: 1, minWidth: 90 }}><b className="num" style={{ fontSize: 20 }}>{n.toLocaleString('en')}</b><div className="muted small">{label}</div></div>
);

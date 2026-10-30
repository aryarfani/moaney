import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { reportsApi, type Overview, type Period } from '../api-reports';
import { useStore } from '../store';
import './reports.css';

const PERIODS: [Period, string][] = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const jakartaToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const level = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : v / max <= 1 / 3 ? 1 : v / max <= 2 / 3 ? 2 : 3);

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

function Heatmap({ data, money }: { data: Overview; money: (n: number) => string }) {
  const max = Math.max(0, ...data.trend.map((t) => t.total));
  return (
    <div role="img" aria-label={`Calendar heatmap of daily spending for ${data.label}. Darker means more spent.`}>
      <div className="heat-head">{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="heat">
        {Array.from({ length: data.leadingBlanks }, (_, i) => <div key={`b${i}`} className="cell blank" />)}
        {data.trend.map((t) => <div key={t.key} className={`cell l${level(t.total, max)}`} title={`${t.label}: ${money(t.total)}`} />)}
      </div>
      <div className="legend">
        <span>less</span><i style={{ background: 'var(--h0)' }} /><i style={{ background: 'var(--h1)' }} /><i style={{ background: 'var(--h2)' }} /><i style={{ background: 'var(--h3)' }} /><span>more</span>
      </div>
    </div>
  );
}

function BarTrend({ data, compact }: { data: Overview; compact: (n: number) => string }) {
  const max = Math.max(0, ...data.trend.map((t) => t.total));
  return (
    <div className="bars" role="img" aria-label={`Spending by ${data.period === 'yearly' ? 'month' : 'day'}`}>
      {data.trend.map((t) => (
        <div key={t.key} className={`col ${t.total === 0 ? 'zero' : ''}`} title={`${t.label}: ${compact(t.total)}`}>
          <i style={{ height: `${max ? Math.max(3, Math.round((t.total / max) * 72)) : 3}px` }} />
          <span>{data.period === 'yearly' ? t.label.slice(0, 1) : t.label.split(' ')[0]}</span>
        </div>
      ))}
    </div>
  );
}

function Cumulative({ data, money }: { data: Overview; money: (n: number) => string }) {
  const c = data.cumulative!;
  const W = 326, H = 96, top = 4, bottom = 90;
  const max = Math.max(1, ...c.current, ...c.previous);
  const n = Math.max(c.current.length, c.previous.length, 2);
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const path = (xs: number[]) => xs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const at = c.current.length - 1;
  const diff = at >= 0 ? c.current[at]! - (c.previous[Math.min(at, c.previous.length - 1)] ?? 0) : 0;
  const sentence = c.current.length === 0 ? '' : diff === 0 ? `Same as ${data.previousLabel} so far` : `${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${data.previousLabel}`;
  return (
    <section className="card" aria-label="Spending so far">
      <div className="row between small" style={{ marginBottom: 8 }}><b>Spending so far</b><span className="muted">{sentence}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="96" role="img" aria-label={`Cumulative spending this period compared with ${data.previousLabel}. ${sentence}.`} style={{ display: 'block' }}>
        <path d={`M0 72H${W}M0 48H${W}M0 24H${W}`} stroke="var(--line)" strokeWidth="1" fill="none" />
        {c.previous.length > 1 && <path d={path(c.previous)} stroke="var(--prev-line)" strokeWidth="2" strokeDasharray="4 4" fill="none" strokeLinecap="round" />}
        {c.current.length > 1 && <path d={path(c.current)} stroke="var(--accent)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
      <div className="line-key">
        <span><i style={{ background: 'var(--accent)' }} />{data.label}</span>
        <span><i style={{ background: 'var(--prev-line)' }} />{data.previousLabel}</span>
      </div>
    </section>
  );
}

export function ReportsPage() {
  const { money, compact } = useStore();
  const [period, setPeriod] = useState<Period>('monthly');
  const [date, setDate] = useState(jakartaToday());
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await reportsApi.overview(period, date));
      setError('');
    } catch {
      setError('Could not load. Check your connection.');
    }
  }, [period, date]);
  useEffect(() => { void load(); }, [load]);

  const today = jakartaToday();
  const isCurrent = data ? data.to >= today : true;
  const delta = data ? data.out - data.in : 0;
  const maxCat = Math.max(0, ...(data?.categories.map((c) => c.total) ?? []));

  return (
    <>
      <header className="row between">
        <h1>Reports</h1>
        <div className="period-pill">
          <button aria-label="Previous period" onClick={() => data && setDate(data.prevDate)} disabled={!data}><Chevron dir="left" /></button>
          <span aria-live="polite">{data?.label ?? '…'}</span>
          <button aria-label="Next period" onClick={() => data && setDate(data.nextDate)} disabled={!data || isCurrent}><Chevron dir="right" /></button>
        </div>
      </header>

      <div className="seg" role="group" aria-label="Period">
        {PERIODS.map(([p, label]) => (
          <button key={p} type="button" aria-pressed={period === p} onClick={() => { setPeriod(p); setDate(jakartaToday()); }}>{label}</button>
        ))}
      </div>

      {error && <div className="notice" role="alert">{error}</div>}

      {data && (
        <>
          <section className="card" aria-label="Money out">
            <div className="muted small" style={{ fontWeight: 600 }}>Money out</div>
            <div className="big" style={{ fontSize: 30 }}>{money(data.out)}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {data.in > 0 ? (
                <>of {compact(data.in)} income · {delta > 0 ? <b style={{ color: 'var(--over)' }}>{compact(delta)} over</b> : <b>{compact(-delta)} left</b>}</>
              ) : 'No income recorded in this period'}
            </div>

            {data.out === 0 ? (
              <div className="muted" style={{ marginTop: 14, textAlign: 'center' }}>Nothing spent in this period.</div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <div className="row between small" style={{ marginBottom: 8 }}>
                  <b>{data.period === 'yearly' ? 'Monthly trend' : 'Daily trend'}</b>
                  <span className="muted">avg {compact(data.avgPerDay)}/day</span>
                </div>
                {data.period === 'monthly' ? <Heatmap data={data} money={money} /> : <BarTrend data={data} compact={compact} />}
              </div>
            )}
          </section>

          {data.cumulative && data.out > 0 && <Cumulative data={data} money={money} />}

          {data.categories.length > 0 && (
            <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="Where it went">
              <div className="row between small"><b>Where it went</b><span className="muted">{data.categories.length} {data.categories.length === 1 ? 'category' : 'categories'}</span></div>
              {data.categories.map((c) => (
                <div key={c.categoryId}>
                  <div className="row between" style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                    <span><span aria-hidden="true">{c.emoji}</span> {c.name}</span><span className="num">{money(c.total)}</span>
                  </div>
                  <div className="cat-bar" role="img" aria-label={`${Math.round(c.share * 100)} percent of spending`}><div style={{ width: `${maxCat ? Math.max(2, Math.round((c.total / maxCat) * 100)) : 0}%` }} /></div>
                </div>
              ))}
            </section>
          )}

          <Link to="/ask" className="btn ghost">Ask Moaney about your money</Link>
        </>
      )}
    </>
  );
}

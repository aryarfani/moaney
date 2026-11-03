import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { reportsApi, type Overview, type Period } from '../api-reports';
import { useStore } from '../store';
import './reports.css';
import './desk-money.css';

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

function Heatmap({ data, money, compact }: { data: Overview; money: (n: number) => string; compact: (n: number) => string }) {
  const max = Math.max(0, ...data.trend.map((t) => t.total));
  return (
    <div role="img" aria-label={`Calendar heatmap of daily spending for ${data.label}. Darker means more spent.`}>
      <div className="heat-head">{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="heat">
        {Array.from({ length: data.leadingBlanks }, (_, i) => <div key={`b${i}`} className="cell blank" />)}
        {data.trend.map((t) => <div key={t.key} className={`cell l${level(t.total, max)}`} title={`${t.label}: ${money(t.total)}`}>{t.total > 0 && compact(t.total).replace('Rp', '')}</div>)}
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
          {t.total > 0 && <em>{compact(t.total).replace('Rp', '')}</em>}
          <i style={{ height: `${max ? Math.max(3, Math.round((t.total / max) * 56)) : 3}px` }} />
          <span>{data.period === 'yearly' ? t.label.slice(0, 1) : t.label.split(' ')[0]}</span>
        </div>
      ))}
    </div>
  );
}

interface FlowNode { name: string; value: number; color: string }

/** Income sources -> one pool -> spending categories. A shortfall enters as "Beyond income"; a surplus leaves as "Saved". */
function Sankey({ data, compact }: { data: Overview; compact: (n: number) => string }) {
  const left: FlowNode[] = data.incomeCategories.map((c) => ({ name: `${c.emoji} ${c.name}`, value: c.total, color: 'var(--accent)' }));
  const right: FlowNode[] = data.categories.map((c) => ({ name: `${c.emoji} ${c.name}`, value: c.total, color: 'var(--h2)' }));
  const sum = (xs: FlowNode[]) => xs.reduce((s, n) => s + n.value, 0);
  const gap = sum(right) - sum(left);
  if (gap > 0) left.push({ name: 'Beyond income', value: gap, color: 'var(--over)' });
  else if (gap < 0) right.push({ name: 'Saved', value: -gap, color: 'var(--accent)' });
  const T = Math.max(sum(left), sum(right));
  if (T <= 0) return null;

  const W = 900, GAP = 12, MIN = 6, NW = 14, XL = 180, XM = 440, XR = 706;
  const k = Math.min(...[left, right].map((col) => (400 - GAP * Math.max(0, col.length - 1)) / T));
  const h = (v: number) => Math.max(MIN, v * k);
  const colH = (col: FlowNode[]) => col.reduce((s, n) => s + h(n.value), 0) + GAP * Math.max(0, col.length - 1);
  const H = Math.max(colH(left), colH(right)) + 8;
  const place = (col: FlowNode[]) => {
    let y = (H - colH(col)) / 2;
    return col.map((n) => { const p = { n, y, h: h(n.value) }; y += p.h + GAP; return p; });
  };
  const L = place(left), R = place(right);
  const midH = Math.max(L.reduce((s, p) => s + p.h, 0), R.reduce((s, p) => s + p.h, 0));
  const midTop = (H - midH) / 2;
  const stack = (ps: { h: number }[]) => { let y = midTop + (midH - ps.reduce((s, p) => s + p.h, 0)) / 2; return ps.map((p) => { const t = y; y += p.h; return t; }); };
  const lm = stack(L), rm = stack(R);
  const ribbon = (x0: number, y0: number, x1: number, y1: number, hh: number) => {
    const c = (x1 - x0) / 2;
    return `M${x0} ${y0}C${x0 + c} ${y0} ${x1 - c} ${y1} ${x1} ${y1}L${x1} ${y1 + hh}C${x1 - c} ${y1 + hh} ${x0 + c} ${y0 + hh} ${x0} ${y0 + hh}Z`;
  };
  const label = (n: FlowNode) => `${n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name}  ${compact(n.value).replace('Rp', '')}`;

  return (
    <section className="card d-flow" aria-label="Money flow">
      <div className="row between small" style={{ marginBottom: 8 }}><b>Where the money flowed</b><span className="muted">{data.label}</span></div>
      <div className="flow-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sankey diagram from income sources to spending categories">
          {L.map((p, i) => <path key={`lr${i}`} d={ribbon(XL + NW, p.y, XM, lm[i]!, p.h)} fill={p.n.color} opacity="0.35" />)}
          {R.map((p, i) => <path key={`rr${i}`} d={ribbon(XM + NW, rm[i]!, XR, p.y, p.h)} fill={p.n.color} opacity="0.35" />)}
          <rect x={XM} y={midTop} width={NW} height={midH} rx="3" fill="var(--h3)" />
          {L.map((p, i) => (
            <g key={`l${i}`}>
              <rect x={XL} y={p.y} width={NW} height={p.h} rx="3" fill={p.n.color} />
              <text x={XL - 8} y={p.y + p.h / 2} textAnchor="end" dominantBaseline="central" fontSize="12" fontWeight="600" fill="var(--ink)">{label(p.n)}</text>
            </g>
          ))}
          {R.map((p, i) => (
            <g key={`r${i}`}>
              <rect x={XR} y={p.y} width={NW} height={p.h} rx="3" fill={p.n.color} />
              <text x={XR + NW + 8} y={p.y + p.h / 2} dominantBaseline="central" fontSize="12" fontWeight="600" fill="var(--ink)">{label(p.n)}</text>
            </g>
          ))}
        </svg>
      </div>
    </section>
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
      <div className="d-top">
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
      </div>

      {error && <div className="notice" role="alert">{error}</div>}

      {data && (
        <div className="d-reports">
          <div className="d-kpis">
            <div className="card"><div className="muted small">Money out</div><div className="d-kpi num">{money(data.out)}</div><div className="muted small">{data.in > 0 ? (delta > 0 ? `${compact(delta)} over income` : `${compact(-delta)} under income`) : 'No income recorded'}</div></div>
            <div className="card"><div className="muted small">Money in</div><div className="d-kpi num">{money(data.in)}</div><div className="muted small">Salary and other income</div></div>
            <div className="card"><div className="muted small">Average per day</div><div className="d-kpi num">{money(data.avgPerDay)}</div><div className="muted small">{data.count} {data.count === 1 ? 'payment' : 'payments'} in this period</div></div>
            <div className="card"><div className="muted small">Versus {data.previousLabel}</div><div className="d-kpi num">{data.out >= data.previousOut ? '+' : '−'}{money(Math.abs(data.out - data.previousOut))}</div><div className="muted small">{data.out >= data.previousOut ? 'More' : 'Less'} spent than {data.previousLabel}</div></div>
          </div>
          <div className="d-main">
          <div className="d-left">
          <section className="card" aria-label="Money out">
            <div className="d-hide">
              <div className="muted small" style={{ fontWeight: 600 }}>Money out</div>
              <div className="big" style={{ fontSize: 30 }}>{money(data.out)}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {data.in > 0 ? (
                  <>of {compact(data.in)} income · {delta > 0 ? <b style={{ color: 'var(--over)' }}>{compact(delta)} over</b> : <b>{compact(-delta)} left</b>}</>
                ) : 'No income recorded in this period'}
              </div>
            </div>

            {data.out === 0 ? (
              <div className="muted" style={{ marginTop: 14, textAlign: 'center' }}>Nothing spent in this period.</div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <div className="row between small" style={{ marginBottom: 8 }}>
                  <b>{data.period === 'yearly' ? 'Monthly trend' : 'Daily trend'}</b>
                  <span className="muted">avg {compact(data.avgPerDay)}/day</span>
                </div>
                {data.period === 'monthly' ? <Heatmap data={data} money={money} compact={compact} /> : <BarTrend data={data} compact={compact} />}
              </div>
            )}
          </section>

          {data.cumulative && data.out > 0 && <Cumulative data={data} money={money} />}
          </div>
          <div className="d-right">
          {data.categories.length > 0 && (
            <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="Where it went">
              <div className="row between small"><b>Where it went</b><span className="muted">{data.categories.length} {data.categories.length === 1 ? 'category' : 'categories'}</span></div>
              {data.categories.map((c) => (
                <div key={c.categoryId} className="cat-row">
                  <div className="row between cat-head" style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                    <span><span aria-hidden="true">{c.emoji}</span> {c.name}</span><span className="num">{money(c.total)}</span>
                    <span className="d-only num muted">{Math.round(c.share * 100)}%</span>
                  </div>
                  <div className="cat-bar" role="img" aria-label={`${Math.round(c.share * 100)} percent of spending`}><div style={{ width: `${maxCat ? Math.max(2, Math.round((c.total / maxCat) * 100)) : 0}%` }} /></div>
                </div>
              ))}
            </section>
          )}

          <Link to="/ask" className="btn ghost">Ask Moaney about your money</Link>
          </div>
          </div>
          <Sankey data={data} compact={compact} />
        </div>
      )}
    </>
  );
}

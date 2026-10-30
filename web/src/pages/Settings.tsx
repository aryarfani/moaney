import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { planApi, type SettingsSummary } from '../api-plan';
import { useStore } from '../store';
import './plan.css';
import './desk-settings.css';

export function BackHeader({ to, title, sub }: { to: string; title: string; sub?: string }) {
  return (
    <header className="back-head">
      <Link to={to} className="back-btn" aria-label="Back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      </Link>
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted small">{sub}</div>}
      </div>
    </header>
  );
}

function Row({ to, emoji, title, sub, badge }: { to: string; emoji: string; title: string; sub: string; badge?: number }) {
  return (
    <Link to={to} className="item">
      <span className="emoji" aria-hidden="true">{emoji}</span>
      <span className="grow"><b>{title}</b><div className="sub">{sub}</div></span>
      {badge ? <span className="badge">{badge}</span> : null}
      <span className="chev" aria-hidden="true">›</span>
    </Link>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="set-group">
      <h2>{title}</h2>
      <div className="card flush">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const { signOut, compact } = useStore();
  const [s, setS] = useState<SettingsSummary | null>(null);

  useEffect(() => {
    planApi.summary().then(setS).catch(() => undefined);
  }, []);

  const next = s?.bills.nextInDays;
  const billSub = !s ? '' : s.bills.count === 0 ? 'No bills yet' : `${plural(s.bills.count, 'bill')}${next !== null && next !== undefined ? ` · next ${next < 0 ? 'overdue' : next === 0 ? 'today' : `in ${plural(next, 'day')}`}` : ''}`;

  return (
    <>
      <BackHeader to="/wallets" title="Settings" />
      <div className="set-groups">
      <Group title="Capture">
        <Row to="/settings/sources" emoji="📲" title="Notification sources" sub="Phones and apps that send notifications" />
        <Row to="/settings/rules" emoji="🧠" title="Rules" sub={s?.suggestedRules ? `${plural(s.suggestedRules, 'suggestion')} waiting` : 'Learned from your corrections'} badge={s?.suggestedRules} />
      </Group>
      <Group title="Plan">
        <Row to="/settings/categories" emoji="🏷️" title="Categories and budgets" sub={s ? plural(s.categories, 'category', 'categories') : ''} />
        <Row to="/settings/goals" emoji="🎯" title="Goals" sub={s ? `${plural(s.goals.count, 'goal')} · ${compact(s.goals.saved)} set aside` : ''} />
        <Row to="/settings/bills" emoji="🧾" title="Recurring bills" sub={billSub} />
      </Group>
      <Group title="Account">
        <Row to="/settings/data" emoji="🔒" title="Data and security" sub="Backup, export, import, notification text" />
        <button className="item" onClick={() => void signOut()}>
          <span className="emoji" aria-hidden="true">🚪</span>
          <span className="grow"><b>Sign out</b></span>
        </button>
      </Group>
      </div>
    </>
  );
}

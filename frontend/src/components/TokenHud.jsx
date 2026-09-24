import { useEffect, useState } from 'react';
import { getTokenUsage } from '../api.js';

// A real usage HUD, not a fake one: numbers come from actually parsing Claude Code's own
// transcript files (see backend/src/tokenUsage.js), the same accounting its own /cost command
// uses. Projects on an agent whose local storage format isn't verified yet (OpenCode, Codex,
// DeepCode) show "not tracked yet" rather than a guessed number.
export default function TokenHud({ openProjects }) {
  const [usage, setUsage] = useState([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const load = () => getTokenUsage().then((r) => setUsage(r.usage)).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!openProjects.length) return null;
  const rows = usage.filter((u) => openProjects.includes(u.project));
  const totalTokens = rows.reduce((sum, r) => sum + (r.totalTokens || 0), 0);
  const totalCost = rows.reduce((sum, r) => sum + (r.estimatedCostUsd || 0), 0);
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <div className={`token-hud ${collapsed ? 'is-collapsed' : ''}`}>
      <button type="button" className="token-hud-head" onClick={() => setCollapsed((v) => !v)}>
        <span>{fmt(totalTokens)} tokens · ~${totalCost.toFixed(2)}</span>
        <span className="token-hud-toggle">{collapsed ? '▲' : '▼'}</span>
      </button>
      {!collapsed && (
        <div className="token-hud-body">
          {rows.map((r) => (
            <div key={r.project} className="token-hud-row">
              <span className="token-hud-project">{r.project}</span>
              {r.tracked ? (
                <span>{fmt(r.totalTokens)} tok · ~${r.estimatedCostUsd.toFixed(3)}</span>
              ) : (
                <span className="token-hud-untracked">not tracked yet ({r.agent})</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

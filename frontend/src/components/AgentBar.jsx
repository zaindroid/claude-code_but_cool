import { useEffect, useState } from 'react';
import { listAgents, getProjectConfig, setProjectConfig } from '../api.js';

// "Guided mode" is a thin layer over the same real terminal, not a separate UI: every button here
// just types one of the agent's own real commands into the live PTY (via sendCommand, wired up in
// App.jsx to that project's actual WebSocket) exactly as if you'd typed it yourself. "Legend mode"
// turns this bar off entirely -- the terminal underneath never changes either way.
export default function AgentBar({ project, sendCommand, hasSession }) {
  const [agents, setAgents] = useState([]);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    setConfig(null);
    getProjectConfig(project).then((r) => setConfig(r.config)).catch(() => {});
  }, [project]);

  if (!config) return null;
  const agentMeta = agents.find((a) => a.id === config.agent);
  if (!agentMeta) return null;

  async function toggleLegend() {
    const next = { ...config, legendMode: !config.legendMode };
    setConfig(next);
    await setProjectConfig(project, { legendMode: next.legendMode });
  }

  function type(cmd) {
    if (!cmd) return;
    sendCommand(`${cmd}\r`);
  }

  return (
    <div className="agent-bar">
      <span className="agent-bar-name">{agentMeta.label}</span>
      {!config.legendMode && (
        <div className="agent-bar-actions">
          {hasSession && agentMeta.id === 'claude' && (
            <button type="button" onClick={() => type('claude --resume')} title="Resume the previous session for this project">Resume</button>
          )}
          <button type="button" onClick={() => type(agentMeta.bin)}>Start</button>
          <button type="button" onClick={() => type(agentLoginCmd(agentMeta))} title={agentMeta.loginHint}>Login / API key</button>
          {agentMeta.inSessionResumeHint && (
            <span className="agent-bar-hint" title={agentMeta.inSessionResumeHint}>? in-session resume</span>
          )}
        </div>
      )}
      <button type="button" className="agent-bar-legend" onClick={toggleLegend}>
        {config.legendMode ? 'Switch to guided mode' : 'Legend mode (plain terminal)'}
      </button>
    </div>
  );
}

function agentLoginCmd(agentMeta) {
  // Every value here is that tool's own real command (see backend/src/agents.js) -- Codez does
  // not implement its own auth for any of them.
  return {
    claude: 'claude',
    opencode: 'opencode auth login',
    codex: 'codex',
    deepcode: 'deepcode provider set',
  }[agentMeta.id];
}

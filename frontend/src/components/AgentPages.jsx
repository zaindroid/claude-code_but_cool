// Which CLI's agents the page is showing: Claude's on one page, DeepCode's on another, and so on.
//
// This is the logged-in page's own top-level navigation, which is why it sits in the deck next to
// the name of the app rather than inside the crew rail, where it started life. Signing in gets you
// terminals; which tool is standing in them is the choice you make up here, and the faces in the
// band below are that choice's answer.
//
// Every CLI this build knows about is listed, always -- not only the ones you already have agents
// on. The tabs used to appear with your second CLI and disappear with your first, which made them
// a consequence of what you happened to have rather than a place you could decide to go. That
// mattered more than it sounds: the page the `+` creates in is the page you are standing on, so an
// absent OpenCode page meant there was no way to make your first OpenCode agent.
//
// A CLI this container cannot actually run is listed and not clickable, with the reason in its
// title. Hiding it would answer "where is Codex?" with silence; letting you open it would offer a
// face that can never start. Availability is the server's own live `command -v`, not the
// Dockerfile's intent -- see agents.js.
export default function AgentPages({ pages = [], active, onPick }) {
  function describe(pg) {
    if (!pg.available && pg.count === 0) return `${pg.label} isn’t installed in your container`;
    if (pg.count === 0) return `No ${pg.label} agents yet — + makes one here`;
    const many = pg.count === 1 ? 'agent' : 'agents';
    // Claude Code's page is genuinely a different kind of place: session names are unique across
    // the whole account and are how agents address each other, so every face on it is a peer.
    // The other CLIs have no equivalent, and saying so is the honest version of a tooltip.
    return pg.id === 'claude'
      ? `${pg.count} Claude Code ${many} — all peers, each reachable by name`
      : `${pg.count} ${pg.label} ${many} — each runs on its own, not addressable by name`;
  }

  return (
    <nav className="deck-pages" aria-label="Agent pages">
      {pages.map((pg) => {
        const on = pg.id === active;
        return (
          <button
            key={pg.id}
            type="button"
            aria-current={on ? 'page' : undefined}
            className={`deck-page ${on ? 'is-on' : ''}`}
            disabled={!pg.available && pg.count === 0}
            title={describe(pg)}
            onClick={() => onPick?.(pg.id)}
          >
            {pg.label}
            {/* Only a real count. Four zeros across the row would be four things to read that
                each say nothing -- an empty page says "no one here yet" in the band itself. */}
            {pg.count > 0 && <span className="deck-page-count">{pg.count}</span>}
          </button>
        );
      })}
    </nav>
  );
}

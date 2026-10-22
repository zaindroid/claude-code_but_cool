import { useEffect, useMemo, useRef, useState } from 'react';

// One list, filtered by typing. This is where every action in Codez lives that is not "click a
// face to put that agent on screen".
//
// It replaces a sidebar, a tab bar, a toolbar and an agent bar, and the reason is not minimalism
// for its own sake: those four regions meant the answer to "where is the thing I want" depended on
// which thing it was, so every glance cost a scan. Here the answer is always the same -- press the
// key, type a few letters. Nothing has to be remembered except the one key, and nothing has to be
// found twice.
//
// Matching is a subsequence test rather than a substring test, so "nwp" finds "New project" the
// way a fuzzy finder would. Deliberately not a scoring algorithm: with a few dozen commands, rank
// by the order they were declared (grouped by relevance) and the result is predictable, which
// matters more here than clever.
function matches(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length;
}

export default function CommandPalette({ commands, onClose }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const visible = useMemo(
    () => commands.filter((c) => !c.hidden && matches(query, `${c.label} ${c.hint || ''} ${c.keywords || ''}`)),
    [commands, query]
  );

  useEffect(() => inputRef.current?.focus(), []);
  // Any change to the query invalidates the old highlight position, so it goes back to the top
  // rather than staying on whatever index happens to still exist.
  useEffect(() => setSel(0), [query]);

  // Keeps the highlighted row in view when arrowing past the edge of the scroll box.
  useEffect(() => {
    listRef.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  function onKeyDown(e) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setSel((s) => (visible.length ? (s + 1) % visible.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setSel((s) => (visible.length ? (s - 1 + visible.length) % visible.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = visible[sel];
      if (cmd) {
        onClose();
        cmd.run();
      }
    }
  }

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Commands"
    >
      <div className="palette">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What do you want to do?"
          aria-label="Search commands"
        />
        {visible.length ? (
          <ul className="palette-list" ref={listRef}>
            {visible.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`palette-item ${i === sel ? 'is-sel' : ''}`}
                  // Mouse hover moves the selection so the keyboard and the pointer never
                  // disagree about what Enter would do.
                  onMouseMove={() => setSel(i)}
                  onClick={() => {
                    onClose();
                    c.run();
                  }}
                >
                  <span>{c.label}</span>
                  {c.hint && <span className="palette-item-sub">{c.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="palette-empty">Nothing matches “{query}”.</p>
        )}
        <div className="palette-foot">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

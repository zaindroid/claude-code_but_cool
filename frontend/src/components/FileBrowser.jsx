import { useEffect, useState } from 'react';
import { listFiles, readFile } from '../api.js';

// A read-only tree, one directory level fetched at a time and cached in state as it's opened --
// simpler than a full recursive tree fetch, and matches how someone actually explores a project
// they didn't just create: a folder or two deep, not the whole thing at once.
export default function FileBrowser({ project }) {
  const [tree, setTree] = useState({ '.': null });
  const [open, setOpen] = useState(new Set(['.']));
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState(null);

  useEffect(() => {
    setTree({ '.': null });
    setOpen(new Set(['.']));
    setSelected(null);
    setContent(null);
    load('.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  async function load(path) {
    try {
      const { entries } = await listFiles(project, path);
      setTree((prev) => ({ ...prev, [path]: entries }));
    } catch {
      setTree((prev) => ({ ...prev, [path]: [] }));
    }
  }

  function toggle(path) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!tree[path]) load(path);
      }
      return next;
    });
  }

  async function openFile(path) {
    setSelected(path);
    setContent(null);
    try {
      const file = await readFile(project, path);
      setContent(file);
    } catch (err) {
      setContent({ content: `Could not open this file: ${err.message}`, truncated: false });
    }
  }

  function renderDir(path, depth) {
    const entries = tree[path];
    if (!entries) return null;
    return entries.map((entry) => {
      const full = path === '.' ? entry.name : `${path}/${entry.name}`;
      if (entry.type === 'dir') {
        const isOpen = open.has(full);
        return (
          <div key={full}>
            <button type="button" className="fb-row fb-dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(full)}>
              <span className={`fb-caret ${isOpen ? 'is-open' : ''}`}>▸</span>
              <span className="fb-name">{entry.name}</span>
            </button>
            {isOpen && renderDir(full, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={full}
          type="button"
          className={`fb-row fb-file ${selected === full ? 'is-selected' : ''}`}
          style={{ paddingLeft: 24 + depth * 14 }}
          onClick={() => openFile(full)}
        >
          <span className="fb-name">{entry.name}</span>
        </button>
      );
    });
  }

  return (
    <div className="file-browser">
      <div className="fb-tree">{renderDir('.', 0)}</div>
      {selected && (
        <div className="fb-preview">
          <div className="fb-preview-head">{selected}</div>
          <pre className="fb-preview-body">{content ? content.content : 'Loading…'}</pre>
          {content?.truncated && <div className="fb-preview-note">Truncated -- this file is larger than what's shown.</div>}
        </div>
      )}
    </div>
  );
}

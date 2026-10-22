import { Blobatar } from '@blobatar/react';
import { idle, thinking, sleepy, happy } from 'blobatar/expression';

// The face of one named agent session.
//
// Seeded on the session *name*, not its id, and that is the whole point: the name is the address
// other agents message it by (sessions.js), so an agent's face is derived from the same string you
// type to talk to it. Rename a session and it gets a new face -- correct, not a bug, because it is
// a new address. Two people looking at the same crew see identical faces with nothing synced,
// since blobatar is deterministic per major version.
//
// Expressions are imported as objects rather than passed as strings because that is blobatar's
// own tree-shaking contract: `blobatar()` never imports the expression module, so a consumer pays
// only for the poses it actually names. These four are the ones this rail can show.
const POSE = {
  // Built for exactly this: blobatar's own notes call `thinking` the one pose whose message is a
  // *duration* rather than a shape -- two eyes at mismatched heights trading places, which is the
  // two-dot loader everyone already reads, except on a face that already has two eyes.
  working: thinking,
  idle,
  // A shell is alive but nothing is happening. Lidded, level, unbothered.
  resting: idle,
  // No shell at all: this session exists and can be woken, but nothing is running.
  asleep: sleepy,
  // Briefly, right after a teleport lands.
  arrived: happy,
};

// `animate` switches the component from an <img> with a data URI to inline SVG, so it is spent
// only where it earns its place: on the agent that is actually working. Everything else is either
// hover-reactive (cheap, and makes the rail feel alive under the cursor) or fully static.
const MOTION = {
  working: 'always',
  idle: 'hover',
  resting: 'hover',
  asleep: false,
  arrived: 'always',
};

export default function CrewAvatar({ name, state = 'idle', size = 40, title }) {
  // The fixed-size box is load-bearing, not styling. Toggling `animate` swaps an <img> for an
  // inline <svg>, and a bare swap between two differently-measured elements is exactly the kind of
  // repeated reflow that AGENT_CONTEXT/KNOWN_ISSUES.md documents as the live-only flicker on this
  // page. Pinning width/height on the wrapper means the swap cannot move anything around it, no
  // matter which element is inside -- the avatar's own motion is then transform and fill only,
  // which never touches layout.
  return (
    <span
      className={`crew-face crew-face-${state}`}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
      title={title || name}
    >
      <Blobatar
        name={name}
        size={size}
        animate={MOTION[state] ?? 'hover'}
        expression={POSE[state] ?? idle}
        title={`${name} (${state})`}
      />
    </span>
  );
}

import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useState, useMemo } from 'react';
import { findCharacter, characters } from '../shared/characters';
import '../shared/tokens.css';
import './Atrium.css';
import './Character.css';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

const phaseCopy: Record<Phase, { label: string; hint: string }> = {
  idle: {
    label: 'Ready when you are',
    hint: 'Tap and speak — or pick a starter below.',
  },
  listening: {
    label: 'Listening',
    hint: 'Take your time. They will not interrupt.',
  },
  thinking: {
    label: 'Thinking',
    hint: 'Holding the moment, picking the words.',
  },
  speaking: {
    label: 'Speaking',
    hint: 'Live voice — no script, no recording.',
  },
};

const promptsByCharacter: Record<string, string[]> = {
  bear: [
    'Tell me a bedtime story',
    'What do bears think about?',
    'What did you do today?',
  ],
  alexander: [
    'How did you cross the desert?',
    'What did you fear?',
    'What advice would you give me?',
  ],
  cleopatra: [
    'How did you become queen?',
    'What did you love most?',
    'What did Egypt feel like?',
  ],
  'da-vinci': [
    'Show me how to draw',
    'What are you sketching?',
    'What is the strangest thing you ever invented?',
  ],
  einstein: [
    'Explain time to me',
    'What is the weirdest thing about light?',
    'What were you wrong about?',
  ],
  'circus-lion': [
    'Tell me about the show',
    'Are you ever scared?',
    'What is your favorite trick?',
  ],
  'grandpa-turtle': [
    'What have you seen?',
    'What is the secret to a long life?',
    'Tell me a slow story',
  ],
  'steve-jobs': [
    'How do you know what is good?',
    'What did you cut?',
    'What did you wish you had built?',
  ],
};

const transcriptByPhase: Record<string, Record<Phase, string>> = {
  default: {
    idle: '',
    listening: 'Tell me about the time you...',
    thinking: '',
    speaking:
      'Pull up a log. I will tell you about the night the river froze and a small fox came to share my fire.',
  },
};

export default function AtriumCharacter() {
  const { id } = useParams();
  const character = findCharacter(id);
  const [params, setParams] = useSearchParams();
  const [autoCycle, setAutoCycle] = useState(false);

  const phase = (params.get('state') as Phase) || 'idle';
  const setPhase = (p: Phase) => setParams({ state: p });

  // Optional auto-cycle through states for a flowing demo
  useEffect(() => {
    if (!autoCycle) return;
    const cycle: Phase[] = ['idle', 'listening', 'thinking', 'speaking'];
    let idx = cycle.indexOf(phase);
    const t = setTimeout(() => {
      idx = (idx + 1) % cycle.length;
      setParams({ state: cycle[idx] });
    }, phase === 'idle' ? 2200 : phase === 'listening' ? 3000 : phase === 'thinking' ? 1800 : 4500);
    return () => clearTimeout(t);
  }, [phase, autoCycle, setParams]);

  const prompts = useMemo(
    () => (id && promptsByCharacter[id]) || [
      'What is on your mind?',
      'Tell me something you know',
      'Surprise me',
    ],
    [id],
  );

  const replyText = useMemo(() => {
    const map = transcriptByPhase[id ?? 'default'] ?? transcriptByPhase.default;
    return map[phase];
  }, [id, phase]);

  if (!character) {
    return (
      <div className="atrium atrium-character">
        <div className="char-missing">
          <h1>Character not found.</h1>
          <Link to="/demo/home" className="btn btn--primary">Back to the cast</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={`atrium atrium-character phase-${phase}`}>
      {/* Stage background */}
      <div className="stage" aria-hidden>
        <img src={character.image} alt="" className="stage__bg" />
        <div className="stage__veil" />
      </div>

      {/* Top HUD */}
      <header className="hud">
        <Link to="/demo/home" className="hud__back" aria-label="Back to all characters">
          <span className="hud__back-arrow">←</span>
          <span>All characters</span>
        </Link>

        <div className="hud__title">
          <span className="hud__sub">{character.subtitle}</span>
          <h1>{character.title}</h1>
        </div>

        <div className="hud__controls">
          <button className="hud__btn" aria-label="Mute">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M19 9l-4 6M15 9l4 6"/></svg>
          </button>
          <button className="hud__btn" aria-label="Settings">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
          </button>
          <Link to="/demo/home" className="hud__btn hud__btn--end">
            End session
          </Link>
        </div>
      </header>

      {/* Demo mode banner — honest about state */}
      <div className="demo-banner">
        <span className="demo-banner__dot" />
        Demo preview — voice and world-model require live API credentials.
        States below are real UI driven by{' '}
        <code>?state=idle|listening|thinking|speaking</code>.
        <button
          className="demo-banner__btn"
          onClick={() => setAutoCycle((v) => !v)}
        >
          {autoCycle ? '◼ Stop auto-cycle' : '▶ Auto-cycle states'}
        </button>
      </div>

      {/* Live transcript / reply */}
      {replyText && (
        <div className="reply">
          <div className="reply__inner">
            <span className="reply__who">
              {phase === 'listening' ? 'You' : character.title}
            </span>
            <p className={phase === 'listening' ? 'reply__user' : 'reply__char'}>
              {replyText}
            </p>
          </div>
        </div>
      )}

      {/* Voice console */}
      <div className="console">
        <div className="orb-wrap">
          <button
            className="orb"
            aria-label={
              phase === 'listening' ? 'Stop speaking' : 'Tap to speak'
            }
            onClick={() => setPhase(phase === 'listening' ? 'thinking' : 'listening')}
          >
            <span className="orb__core" />
            <span className="orb__halo orb__halo--1" />
            <span className="orb__halo orb__halo--2" />
            <span className="orb__halo orb__halo--3" />
            <span className="orb__icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <rect x="9" y="3" width="6" height="12" rx="3"/>
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
              </svg>
            </span>
          </button>
          <div className="orb-meta">
            <span className="orb__label">{phaseCopy[phase].label}</span>
            <span className="orb__hint">{phaseCopy[phase].hint}</span>
          </div>
        </div>

        {/* Starter prompts (only meaningful in idle) */}
        <div className={`prompts ${phase === 'idle' ? 'prompts--on' : 'prompts--off'}`}>
          <span className="prompts__title">Starter prompts</span>
          <div className="prompts__row">
            {prompts.map((p) => (
              <button
                key={p}
                className="prompt-chip"
                onClick={() => setPhase('listening')}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* State switcher (subtle, for evaluating the design) */}
        <div className="state-switcher" role="tablist" aria-label="Preview UI states">
          {(['idle', 'listening', 'thinking', 'speaking'] as Phase[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={phase === p}
              className={`state-pill ${phase === p ? 'state-pill--on' : ''}`}
              onClick={() => setPhase(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Side rail: switch character without leaving */}
      <aside className="rail" aria-label="Switch character">
        <div className="rail__title">
          <span>Switch</span>
        </div>
        <ul>
          {characters.filter((c) => c.id !== character.id).map((c) => (
            <li key={c.id}>
              <Link to={`/demo/character/${c.id}`} title={c.title}>
                <img src={c.image} alt={c.title} loading="lazy" />
                <span>{c.title.split(' ')[0]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

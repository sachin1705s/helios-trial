import { Link } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { characters } from '../shared/characters';
import '../shared/tokens.css';
import './Atrium.css';

const previewIds = ['bear', 'da-vinci', 'cleopatra', 'circus-lion'];
const featuredCharacters = previewIds
  .map((id) => characters.find((c) => c.id === id))
  .filter(Boolean) as typeof characters;

export default function AtriumLanding() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    // Best-effort autoplay — muted, looped, inline. No modal hijack.
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.play().catch(() => undefined);
  }, []);

  return (
    <div className="atrium">
      <AtriumNav />

      {/* HERO */}
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__copy">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> Real-time interactive voice
          </span>
          <h1 id="hero-title">
            Worlds that <em>talk&nbsp;back.</em>
          </h1>
          <p className="lede">
            Speak to a character. Step into a scene. Watch the story bend
            around your voice — in real time, with no script, no scroll, and
            no autoplay feed in sight.
          </p>
          <div className="hero__ctas">
            <Link to="/home" className="btn btn--primary">
              Try a character
              <span className="btn__arrow">→</span>
            </Link>
            <a href="#how" className="btn btn--ghost">
              See how it works
            </a>
          </div>
          <ul className="hero__signals" aria-label="Product highlights">
            <li>
              <span className="dot dot--moss" /> No feed, no recommendations
            </li>
            <li>
              <span className="dot dot--clay" /> Voice-first by design
            </li>
            <li>
              <span className="dot dot--sun" /> Eight characters, more soon
            </li>
          </ul>
        </div>

        <div className="hero__viewfinder">
          <div className="viewfinder">
            <video
              ref={videoRef}
              src="/Starter-Demo.mp4"
              autoPlay
              muted
              loop
              playsInline
              poster="/images/forest-canopy.jpg"
            />
            <div className="viewfinder__chrome">
              <span className="viewfinder__rec" /> LIVE
            </div>
            <div className="viewfinder__caption">
              Steve the Bear, responding to a question
            </div>
          </div>
          <div className="viewfinder__shadow" aria-hidden />
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="how" aria-labelledby="how-title">
        <header>
          <span className="eyebrow eyebrow--center">In thirty seconds</span>
          <h2 id="how-title">
            Three steps. <em>That's the whole thing.</em>
          </h2>
        </header>
        <ol className="how__steps">
          <li>
            <span className="step__num">01</span>
            <h3>Choose who you'd like to meet.</h3>
            <p>
              A wise bear. A Renaissance inventor. A pharaoh. Each character
              has their own voice, world, and way of seeing things.
            </p>
          </li>
          <li>
            <span className="step__num">02</span>
            <h3>Speak in your own voice.</h3>
            <p>
              Press once and talk. No keyboard, no commands. The character is
              listening — and they remember what you said two minutes ago.
            </p>
          </li>
          <li>
            <span className="step__num">03</span>
            <h3>The world responds.</h3>
            <p>
              Not a stock reply. The scene shifts, the character moves, and
              the story bends around the conversation you're actually having.
            </p>
          </li>
        </ol>
      </section>

      {/* DIFFERENT */}
      <section className="manifesto" aria-labelledby="manifesto-title">
        <h2 id="manifesto-title">
          The opposite of <em>passive.</em>
        </h2>
        <div className="manifesto__grid">
          <article>
            <span className="cross">×</span>
            <p className="strike">Not a feed</p>
            <p>
              Nothing autoplays. Nothing scrolls. You don't open the app to
              be served — you open it to be answered.
            </p>
          </article>
          <article>
            <span className="cross">×</span>
            <p className="strike">Not a script</p>
            <p>
              Every conversation runs once. The character is reacting to
              <em> you,</em> not playing back a tape.
            </p>
          </article>
          <article>
            <span className="cross">×</span>
            <p className="strike">Not a chatbot</p>
            <p>
              There's a face. A scene. Eyes that meet yours. You're not
              talking to a textbox — you're inside the conversation.
            </p>
          </article>
        </div>
      </section>

      {/* CHARACTER PREVIEW */}
      <section className="preview" aria-labelledby="preview-title">
        <header>
          <span className="eyebrow">The cast</span>
          <h2 id="preview-title">
            Eight characters. <em>One conversation each.</em>
          </h2>
          <p className="lede lede--center">
            From a thoughtful turtle to the last pharaoh of Egypt — pick the
            voice you want to spend ten minutes with.
          </p>
        </header>
        <div className="preview__grid">
          {featuredCharacters.map((c) => (
            <Link key={c.id} to={`/character/${c.id}`} className="preview__card">
              <div className="preview__photo">
                <img src={c.image} alt={c.title} loading="lazy" />
              </div>
              <div className="preview__meta">
                <span className="preview__sub">{c.subtitle}</span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </div>
              <span className="preview__cta">Talk to {c.title.split(' ')[0]} →</span>
            </Link>
          ))}
        </div>
        <div className="preview__more">
          <Link to="/home" className="btn btn--ghost btn--lg">
            See all eight →
          </Link>
        </div>
      </section>

      {/* QUOTE / MANIFESTO */}
      <section className="quote">
        <blockquote>
          <p>
            The first medium that's <em>actually</em> interactive — not a feed
            you scroll, but a conversation you have.
          </p>
          <footer>— what we're trying to make</footer>
        </blockquote>
      </section>

      <AtriumFooter />
    </div>
  );
}

export function AtriumNav() {
  return (
    <nav className="nav" aria-label="Primary">
      <Link to="/" className="nav__brand">
        <span className="nav__mark">◐</span>
        Interact Studio
      </Link>
      <div className="nav__links">
        <a href="#how">How it works</a>
        <Link to="/home">Characters</Link>
        <a href="#" onClick={(e) => e.preventDefault()}>About</a>
      </div>
      <Link to="/home" className="btn btn--primary btn--sm">
        Try a character
      </Link>
    </nav>
  );
}

export function AtriumFooter() {
  return (
    <footer className="foot">
      <div className="foot__top">
        <div className="foot__brand">
          <span className="nav__mark">◐</span>
          <span>Interact Studio</span>
        </div>
        <div className="foot__cols">
          <div>
            <h4>Product</h4>
            <Link to="/home">Characters</Link>
            <a href="#how">How it works</a>
            <a href="#" onClick={(e) => e.preventDefault()}>What's new</a>
          </div>
          <div>
            <h4>Company</h4>
            <a href="#" onClick={(e) => e.preventDefault()}>About</a>
            <a href="#" onClick={(e) => e.preventDefault()}>Press</a>
            <a href="#" onClick={(e) => e.preventDefault()}>Contact</a>
          </div>
          <div>
            <h4>Community</h4>
            <a href="#" onClick={(e) => e.preventDefault()}>Discord</a>
            <a href="#" onClick={(e) => e.preventDefault()}>X / Twitter</a>
            <a href="#" onClick={(e) => e.preventDefault()}>Instagram</a>
          </div>
        </div>
      </div>
      <div className="foot__bottom">
        <span>© Interact Studio 2026</span>
        <span>Made for curious minds, anywhere.</span>
      </div>
    </footer>
  );
}

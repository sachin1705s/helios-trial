import { Link } from 'react-router-dom';
import { characters } from '../shared/characters';
import '../shared/tokens.css';
import './Storyline.css';

const previewIds = ['bear', 'da-vinci', 'cleopatra', 'circus-lion'];
const featured = previewIds
  .map((id) => characters.find((c) => c.id === id))
  .filter(Boolean) as typeof characters;

export default function StorylineLanding() {
  return (
    <div className="storyline">
      <nav className="sl-nav">
        <Link to="/demo/landing-storyline" className="sl-brand">
          <span className="sl-brand__sticker">★</span>
          <span>Interact Studio</span>
        </Link>
        <div className="sl-nav__links">
          <a href="#how">How it works</a>
          <Link to="/demo/home">Cast</Link>
          <a href="#about" onClick={(e) => e.preventDefault()}>About</a>
        </div>
        <Link to="/demo/home" className="sl-btn sl-btn--red">
          Press to play
        </Link>
      </nav>

      <header className="sl-hero">
        <div className="sl-hero__copy">
          <span className="sl-eyebrow sl-eyebrow--blue">A read-aloud you can talk to</span>
          <h1>
            Stories that <em>talk&nbsp;back.</em>
          </h1>
          <p>
            Open a page and a character looks up. You speak — they answer.
            No screens to scroll. No videos to swipe. Just a story that
            listens.
          </p>
          <div className="sl-cta-row">
            <Link to="/demo/home" className="sl-btn sl-btn--red sl-btn--big">
              Press to play →
            </Link>
            <a href="#how" className="sl-link">
              How it works
            </a>
          </div>
          <ul className="sl-stickers">
            <li className="sl-stickers__item sl-stickers__item--yellow">No ads</li>
            <li className="sl-stickers__item sl-stickers__item--green">Voice only</li>
            <li className="sl-stickers__item sl-stickers__item--purple">Eight friends</li>
          </ul>
        </div>
        <div className="sl-hero__art">
          <div className="sl-frame sl-frame--main">
            <img src="/images/character-background/bear2.webp" alt="Steve the Bear" />
            <span className="sl-frame__tag">Steve the Bear</span>
          </div>
          <div className="sl-frame sl-frame--inset sl-frame--blue">
            <img src="/images/character-background/da-vinci-2.webp" alt="Da Vinci" />
          </div>
          <div className="sl-frame sl-frame--inset sl-frame--purple">
            <img src="/images/character-background/cleopetra-2.webp" alt="Cleopatra" />
          </div>
        </div>
      </header>

      <section id="how" className="sl-how">
        <span className="sl-eyebrow sl-eyebrow--green sl-eyebrow--center">In thirty seconds</span>
        <h2>How it works</h2>
        <ol>
          <li className="sl-step sl-step--red">
            <span className="sl-step__num">1</span>
            <h3>Pick a friend.</h3>
            <p>Eight characters, each with their own voice and world.</p>
          </li>
          <li className="sl-step sl-step--blue">
            <span className="sl-step__num">2</span>
            <h3>Say something.</h3>
            <p>Press once and talk. Use your real voice — they're listening.</p>
          </li>
          <li className="sl-step sl-step--yellow">
            <span className="sl-step__num">3</span>
            <h3>The story moves.</h3>
            <p>Not a stock answer. The whole scene bends around what you said.</p>
          </li>
        </ol>
      </section>

      <section className="sl-cast">
        <span className="sl-eyebrow sl-eyebrow--purple sl-eyebrow--center">The cast</span>
        <h2>Eight friends. One conversation each.</h2>
        <div className="sl-cast__grid">
          {featured.map((c) => (
            <Link key={c.id} to={`/demo/character/${c.id}`} className="sl-card">
              <div className="sl-card__photo">
                <img src={c.image} alt={c.title} />
              </div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <span className="sl-card__cta">Talk to {c.title.split(' ')[0]} →</span>
            </Link>
          ))}
        </div>
        <div className="sl-cta-center">
          <Link to="/demo/home" className="sl-btn sl-btn--blue sl-btn--big">
            See all eight →
          </Link>
        </div>
      </section>

      <footer className="sl-foot">
        <div>
          <span className="sl-brand__sticker">★</span>
          <strong>Interact Studio</strong>
          <p>Made for curious minds, anywhere.</p>
        </div>
        <div className="sl-foot__links">
          <a href="#" onClick={(e) => e.preventDefault()}>Discord</a>
          <a href="#" onClick={(e) => e.preventDefault()}>Instagram</a>
          <a href="#" onClick={(e) => e.preventDefault()}>X / Twitter</a>
        </div>
      </footer>
    </div>
  );
}

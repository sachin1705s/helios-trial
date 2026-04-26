import { Link } from 'react-router-dom';
import './shared/tokens.css';
import './Index.css';

const variants = [
  {
    href: '/demo/landing',
    title: 'Atrium — Landing',
    subtitle: 'Warm editorial. Recommended direction. High fidelity.',
    badge: 'Recommended',
  },
  {
    href: '/demo/home',
    title: 'Atrium — Home',
    subtitle: 'Character chooser. Featured + quieter row. All eight characters.',
    badge: 'Atrium',
  },
  {
    href: '/demo/character/bear',
    title: 'Atrium — Character stage',
    subtitle: 'Voice orb, four states (?state=idle|listening|thinking|speaking).',
    badge: 'Atrium',
  },
  {
    href: '/demo/landing-storyline',
    title: 'Storyline — Landing',
    subtitle: 'Picture-book first. Crayon palette, hand-drawn feel.',
    badge: 'Variant',
  },
  {
    href: '/demo/landing-studio',
    title: 'Studio Black — Landing',
    subtitle: 'Cinematic, premium, dark by default.',
    badge: 'Variant',
  },
];

export default function DemoIndex() {
  return (
    <div className="demo-index">
      <header>
        <span className="kicker">Design refresh — v1</span>
        <h1>Pick a direction.</h1>
        <p>
          Three design systems. Atrium is fully built across the three core
          screens. Storyline and Studio Black are landing-only previews so you
          can compare aesthetics before committing.
        </p>
      </header>

      <ul>
        {variants.map((v) => (
          <li key={v.href}>
            <Link to={v.href}>
              <span className="badge">{v.badge}</span>
              <h2>{v.title}</h2>
              <p>{v.subtitle}</p>
              <span className="arrow">→</span>
            </Link>
          </li>
        ))}
      </ul>

      <footer>
        Live site: <a href="/">Existing app at /</a> &middot; Branch:
        <code>design-refresh-v1</code>
      </footer>
    </div>
  );
}

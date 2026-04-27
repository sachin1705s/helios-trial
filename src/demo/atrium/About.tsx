import { AtriumNav, AtriumFooter } from './Landing';
import '../shared/tokens.css';
import './Atrium.css';
import './About.css';

export default function AtriumAbout() {
  return (
    <div className="atrium">
      <AtriumNav />

      <section className="about-hero" aria-labelledby="about-title">
        <span className="eyebrow">About us</span>
        <h1 id="about-title">
          We're building media<br />
          that actually <em>responds.</em>
        </h1>
      </section>

      <div className="about-body">
        <p className="about-lead">
          Content is becoming abundant, but it is still static. You sit there and watch.
        </p>

        <p>We think that model is running out of road.</p>

        <p>
          We are building real-time interactive video where you can talk to characters and
          change what happens as the experience unfolds.
        </p>

        <p>The story shifts. The environment reacts. The flow changes with you.</p>

        <p>It feels less like watching something and more like being inside it.</p>

        <p>
          We are a small team building quickly across world models, synthetic data, and
          real-time systems, getting early versions into people's hands and iterating fast.
        </p>

        <div className="about-why">
          <h2>Why we're building this.</h2>
          <p>Content is exploding, but the experience of it is still mostly passive.</p>
          <p>We think the next step is media that listens, reacts, and changes with you.</p>
        </div>

        <a
          className="about-read-more"
          href="https://open.substack.com/pub/maxmill06/p/everything-youve-ever-watched-is?r=3xodvz&utm_campaign=post&utm_medium=web&showWelcomeOnShare=true"
          target="_blank"
          rel="noreferrer"
        >
          Read more →
        </a>
      </div>

      <AtriumFooter />
    </div>
  );
}

export const SITE_URL = 'https://interactstudio.space';
const DEFAULT_IMAGE = `${SITE_URL}/images/forest-canopy.jpg`;

type SeoPage = {
  title: string;
  description: string;
  path: string;
  type?: 'website' | 'article';
};

export const SEO_PAGES = {
  home: {
    title: 'Interact Studio | Talk to AI Characters in Real Time',
    description:
      'Interact Studio lets you talk to interactive AI characters in real time through live voice, generative media, and character-driven storytelling.',
    path: '/',
    type: 'website',
  },
  about: {
    title: 'About Interact Studio',
    description:
      'Interact Studio is building real-time interactive video where media responds, characters talk back, and viewers can change what happens.',
    path: '/about-us',
    type: 'article',
  },
  contact: {
    title: 'Contact Interact Studio',
    description:
      'Contact Interact Studio for partnerships, questions, demos, and creative collaboration around interactive AI characters.',
    path: '/contact',
    type: 'article',
  },
} satisfies Record<string, SeoPage>;

const ORGANIZATION_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Interact Studio',
  url: SITE_URL,
  logo: `${SITE_URL}/favicon.jpeg`,
  sameAs: [
    'https://x.com/interact_studio',
    'https://www.instagram.com/iinteractstudio/',
    'https://discord.gg/S4b2sJrsuS',
  ],
  contactPoint: [
    {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: 'hello.interactstudio@gmail.com',
      url: `${SITE_URL}/contact`,
    },
  ],
};

const WEBSITE_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Interact Studio',
  url: SITE_URL,
  description: SEO_PAGES.home.description,
  publisher: {
    '@type': 'Organization',
    name: 'Interact Studio',
  },
};

function upsertMeta(selector: string, attributes: Record<string, string>) {
  let element = document.head.querySelector(selector) as HTMLMetaElement | null;
  if (!element) {
    element = document.createElement('meta');
    document.head.appendChild(element);
  }

  Object.entries(attributes).forEach(([key, value]) => {
    element?.setAttribute(key, value);
  });
}

function upsertLink(selector: string, attributes: Record<string, string>) {
  let element = document.head.querySelector(selector) as HTMLLinkElement | null;
  if (!element) {
    element = document.createElement('link');
    document.head.appendChild(element);
  }

  Object.entries(attributes).forEach(([key, value]) => {
    element?.setAttribute(key, value);
  });
}

function upsertJsonLd(id: string, payload: Record<string, unknown>) {
  let element = document.head.querySelector(`#${id}`) as HTMLScriptElement | null;
  if (!element) {
    element = document.createElement('script');
    element.type = 'application/ld+json';
    element.id = id;
    document.head.appendChild(element);
  }

  element.textContent = JSON.stringify(payload);
}

export function applySeo(page: SeoPage) {
  const canonicalUrl = new URL(page.path, SITE_URL).toString();
  document.title = page.title;

  upsertMeta('meta[name="description"]', { name: 'description', content: page.description });
  upsertMeta('meta[name="robots"]', { name: 'robots', content: 'index,follow,max-image-preview:large' });
  upsertMeta('meta[property="og:title"]', { property: 'og:title', content: page.title });
  upsertMeta('meta[property="og:description"]', { property: 'og:description', content: page.description });
  upsertMeta('meta[property="og:type"]', { property: 'og:type', content: page.type ?? 'website' });
  upsertMeta('meta[property="og:url"]', { property: 'og:url', content: canonicalUrl });
  upsertMeta('meta[property="og:image"]', { property: 'og:image', content: DEFAULT_IMAGE });
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: page.title });
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: page.description });
  upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image', content: DEFAULT_IMAGE });
  upsertLink('link[rel="canonical"]', { rel: 'canonical', href: canonicalUrl });

  upsertJsonLd('seo-organization', ORGANIZATION_SCHEMA);
  upsertJsonLd('seo-website', WEBSITE_SCHEMA);
  upsertJsonLd('seo-webpage', {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: page.title,
    description: page.description,
    url: canonicalUrl,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Interact Studio',
      url: SITE_URL,
    },
    about: {
      '@type': 'Organization',
      name: 'Interact Studio',
      url: SITE_URL,
    },
  });
}

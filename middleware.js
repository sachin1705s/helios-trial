// Vercel Edge Middleware — serves crawler-friendly HTML with OG meta tags
// for routes that need custom social previews. Runs before the SPA catch-all
// rewrite, so crawlers (which don't execute JS) get proper og:image etc.

const CRAWLER_UA = /Twitterbot|facebookexternalhit|Slackbot|Slack-ImgProxy|LinkedInBot|Discordbot|WhatsApp|TelegramBot|Applebot|Googlebot|bingbot/i;

const OG_PAGES = {
  '/lab/gesture': {
    title: "Find Einstein's 10 Secret Reactions | Interact Studio",
    description: "You have 3 minutes to trigger all 10 of Einstein's hidden gesture reactions via your webcam. One attempt per day.",
    image: 'https://interactstudio.space/images/og-gesture.png',
    url: 'https://interactstudio.space/lab/gesture',
  },
};

function buildOgHtml({ title, description, image, url }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${image}" />
  <link rel="canonical" href="${url}" />
</head>
<body>
  <h1>${title}</h1>
  <p>${description}</p>
  <p><a href="${url}">Play now</a></p>
</body>
</html>`;
}

export default function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Only intercept if this is a known OG page
  const ogData = OG_PAGES[pathname];
  if (!ogData) return;

  // Only intercept for crawlers — real users get the SPA
  const ua = request.headers.get('user-agent') || '';
  if (!CRAWLER_UA.test(ua)) return;

  return new Response(buildOgHtml(ogData), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export const config = {
  matcher: ['/lab/gesture'],
};

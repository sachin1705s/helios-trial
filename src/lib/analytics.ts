const SESSION_STORAGE_KEY = 'interact_analytics_session_id';
const VISITOR_STORAGE_KEY = 'interact_analytics_visitor_id';
const LAST_VISIT_STORAGE_KEY = 'interact_analytics_last_visit_at';

export type AnalyticsPayload = Record<string, unknown>;

type VisitState = {
  visitorId: string;
  isNewVisitor: boolean;
  isReturnVisit: boolean;
  lastVisitAt: string | null;
};

const getReferrerUrl = (): URL | null => {
  try {
    if (!document.referrer) return null;
    return new URL(document.referrer);
  } catch {
    return null;
  }
};

const getReferrerContext = () => {
  const referrerUrl = getReferrerUrl();
  const referrer = document.referrer || null;
  const referrerHost = referrerUrl?.host ?? null;
  const currentHost = window.location.host;
  const isInternalReferrer = Boolean(referrerHost && referrerHost === currentHost);

  return {
    referrer,
    referrerHost,
    isInternalReferrer,
  };
};

const getUtmContext = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    utmSource: params.get('utm_source'),
    utmMedium: params.get('utm_medium'),
    utmCampaign: params.get('utm_campaign'),
    utmTerm: params.get('utm_term'),
    utmContent: params.get('utm_content'),
  };
};

const getWindowData = () => ({
  path: window.location.pathname,
  url: window.location.href,
  ...getReferrerContext(),
  ...getUtmContext(),
  viewport: {
    width: window.innerWidth,
    height: window.innerHeight,
  },
});

export const getAnalyticsSessionId = (): string => {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
};

export const getAnalyticsVisitorId = (): string => {
  try {
    const existing = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(VISITOR_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
};

export const getVisitState = (): VisitState => {
  const visitorId = getAnalyticsVisitorId();
  try {
    const lastVisitAt = window.localStorage.getItem(LAST_VISIT_STORAGE_KEY);
    const now = new Date().toISOString();
    window.localStorage.setItem(LAST_VISIT_STORAGE_KEY, now);
    return {
      visitorId,
      isNewVisitor: !lastVisitAt,
      isReturnVisit: Boolean(lastVisitAt),
      lastVisitAt,
    };
  } catch {
    return {
      visitorId,
      isNewVisitor: false,
      isReturnVisit: false,
      lastVisitAt: null,
    };
  }
};

export const trackEvent = (
  event: string,
  data: AnalyticsPayload = {},
  options?: { transport?: 'fetch' | 'beacon' },
) => {
  const payload = JSON.stringify({
    event,
    data: {
      sessionId: getAnalyticsSessionId(),
      visitorId: getAnalyticsVisitorId(),
      ...getWindowData(),
      ...data,
    },
    timestamp: new Date().toISOString(),
  });

  if (options?.transport === 'beacon' && navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon('/api/log', blob);
    return;
  }

  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: options?.transport === 'beacon',
  }).catch(() => undefined);
};

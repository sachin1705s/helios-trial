import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams, useLocation, Navigate } from 'react-router-dom';
import posthog from 'posthog-js';
import { PostHogProvider, usePostHog } from 'posthog-js/react';



import './index.css';
import App from './App.tsx';
import AtriumLanding from './demo/atrium/Landing';
import AtriumHome from './demo/atrium/Home';
import AtriumAbout from './demo/atrium/About';
import AtriumLabs from './demo/atrium/Labs';
import DrawingExperiment from './components/experiments/DrawingExperiment';
import GestureExperiment from './components/experiments/GestureExperiment';
import ObjectDetectionExperiment from './components/experiments/ObjectDetectionExperiment';
import CustomCharacterExperiment from './components/experiments/CustomCharacterExperiment';
import BroadcastExperiment from './components/experiments/BroadcastExperiment';
import GestureTestHarness from './components/experiments/GestureTestHarness';
import StreamInteractHarness from './components/experiments/StreamInteractHarness';
import ActionStreamHarness from './components/experiments/ActionStreamHarness';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function PostHogPageView() {
  const { pathname } = useLocation();
  const posthog = usePostHog();

  useEffect(() => {
    if (pathname && posthog) {
      posthog.capture('$pageview', {
        $current_url: window.location.href,
      });
    }
  }, [pathname, posthog]);

  return null;
}


function CharacterRoute() {
  const { id } = useParams<{ id: string }>();
  return <App initialCharacterId={id} />;
}

if (import.meta.env.VITE_POSTHOG_KEY) {
  posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
    api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
    person_profiles: 'identified_only', // or 'always' if you want to track anonymous users as well
  });
}


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PostHogProvider client={posthog}>
      <BrowserRouter>
        <ScrollToTop />
        <PostHogPageView />
        <Routes>

          <Route path="/" element={<AtriumLanding />} />
          <Route path="/characters" element={<AtriumHome />} />
          {/* Legacy: the cast page used to live at /home — keep the URL working. */}
          <Route path="/home" element={<Navigate to="/characters" replace />} />
          <Route path="/about-us" element={<AtriumAbout />} />
          <Route path="/labs" element={<AtriumLabs />} />
          <Route path="/character/:id" element={<CharacterRoute />} />
          <Route path="/lab/drawing"   element={<DrawingExperiment />} />
          <Route path="/lab/gesture"   element={<GestureExperiment />} />
          <Route path="/lab/gesture-test" element={<GestureTestHarness />} />
          <Route path="/lab/stream-test"  element={<StreamInteractHarness />} />
          <Route path="/lab/action-test"  element={<ActionStreamHarness />} />
          <Route path="/lab/objects"   element={<ObjectDetectionExperiment />} />
          <Route path="/lab/custom"    element={<CustomCharacterExperiment />} />
          <Route path="/lab/broadcast" element={<BroadcastExperiment />} />
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </PostHogProvider>
  </StrictMode>,

);

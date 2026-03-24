# Experimental Features

These features are fully implemented but removed from the main UI for the MVP launch.
They live in the `experiments` git branch (full working version).

## Features

### Gesture Detection (`App.with-experiments.tsx`)
- Camera-based hand gesture recognition via Gemini Vision API
- Gestures: hello, thumbs up, victory, namaste, wave
- Triggers character animations automatically
- Server endpoint: `POST /api/gesture-vision`

### Object Detection
- MediaPipe-based real-time object detection from camera feed
- Detected objects can trigger contextual prompts

### Voice Cloning
- Record or upload 10–15s of your voice
- Cloned voice replaces default TTS for character responses  
- Server endpoint: `POST /api/voice-clone`

### Voice Agent (Smallest AI Webcall)
- Full real-time voice call with an AI character
- Server endpoint: `POST /api/smallest/webcall`
- Implemented in server but not yet wired to UI on either branch

### Settings Panel
- UI toggles for gesture detection, object detection, voice cloning

## How to re-enable

Switch to the `experiments` branch to run all features:
```bash
git checkout experiments
npm run dev
```

Or cherry-pick individual features from `experimental/App.with-experiments.tsx`.

# NEXORA AI

## Render deployment
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `GEMINI_API_KEY` (your private Google AI Studio API key)
- Optional: `GEMINI_MODEL` (defaults to `gemini-3.8-flash`)

Do not put the API key in frontend files or commit it to GitHub.

## Features
- Gemini chat with multi-turn conversation context
- Image input (JPG, PNG, WEBP; up to 4 images, 5 MB each)
- Optional Google Search grounding (tap Websuche in the chat)
- Browser speech recognition where supported
- Spoken answers using browser text-to-speech
- Responsive mobile / iPad layout and local chat history

Voice recognition availability depends on the browser and operating system. On iPad Safari, if in-page recognition is unavailable, use the microphone key on the iPad keyboard. Spoken answers use the browser's built-in speech synthesis.

Google Search grounding and image input may consume Gemini API quota and are subject to Google's model, account, and regional availability.

# FirstAid Practice Copilot — teammate handoff

## Run locally

From this directory's parent repository:

```bash
python3 -m http.server 4173 --directory prototypes/practice-copilot
```

Open `http://127.0.0.1:4173/`.

## Included product flow

- First-use tutorial with replay from the home screen.
- Three scenarios: adult collapse, adult choking, and severe bleeding.
- Guided practice: teaching demonstration, action, immediate rule feedback.
- Scenario challenge: no demonstration, no immediate answer reveal, final review.
- Simulated voice and camera observations for interaction prototyping.

## Architecture boundary

- `scenarios` in `app.js` owns scenario content and deterministic outcomes.
- Both modes consume the same nodes; challenge mode filters `teach` nodes only.
- Voice/camera UI currently simulates observations and does not request device permissions.
- Gemma must not score actions or advance medical flow when this is migrated.
- Production migration must route observations through `TrainingRuleEngine`.

## Files

- `index.html`: screens and accessible UI structure.
- `styles.css`: dependency-free mobile presentation.
- `app.js`: scenario data, mode state, deterministic feedback, and navigation.
- `previews/`: reference screenshots only.

## Known limitations

- This is a standalone Web prototype, not the Android production implementation.
- Voice and camera recognition are simulated.
- Choking and severe bleeding content requires professional medical review before production use.

# Practice Copilot mobile prototype

Independent, dependency-free product prototype for the multimodal first-aid
practice experience. It deliberately does not connect to the Emergency session,
real phone tools, location, camera, microphone, or Gemma runtime.

Preview locally from the repository root:

```bash
python3 -m http.server 4173 --directory prototypes/practice-copilot
```

Then open `http://127.0.0.1:4173/` with a mobile viewport around 390 × 844.

Implemented flow:

1. Four-step first-use tutorial, with skip and replay from the home screen.
2. Practice Copilot landing screen and three-scenario library.
3. Adult collapse, adult choking, and severe bleeding teaching flows.
4. Reusable teaching, neutral-choice, simulated voice, and simulated camera nodes.
5. Deterministic post-action feedback and scenario-specific completion review.
6. Guided practice and scenario challenge modes backed by the same scenario rules.

Mode behavior:

- **Guided practice** includes teaching nodes and immediate rule explanations.
- **Scenario challenge** skips teaching nodes, records choices without revealing
  correctness, and shows all corrections in the final review.

The choking and bleeding content is a product interaction prototype and still
requires medical review before production use.

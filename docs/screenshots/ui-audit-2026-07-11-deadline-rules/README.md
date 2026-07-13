# Deadline rule UI audit — 2026-07-11

## Evidence

- `01-calculated-desktop-1440.png` — verified rule, authority integrity, calculation controls, and derived proposal at 1440 px.
- `02-calculated-narrow-900.png` — compact rule creation workflow at 900 px.
- `03-retired-stale-mobile-393.png` — refreshed stale deadline and blocked action state at 393 px.

The Playwright scenario uses real backend writes for authority creation and verification, procedural event creation and confirmation, deadline rule creation, rule verification, deadline calculation, refresh, and retirement. It asserts mutation bodies, calculation trace and hash, stale reason, horizontal overflow, and mobile header geometry.

## Sol conclusion

**PASS.** The Procedural Clock presents deadline rules as a restrained counsel workflow rather than a parallel product surface. Authority identity, version, effective interval, exact quote, rule hash, and calculation hash remain inspectable. Business-day counting is visibly unavailable without a trusted court calendar. Calculations are labeled as proposals requiring counsel confirmation. Retirement produces a persistent, prominent stale state and removes confirmation actions. The 1440 px, 900 px, and 393 px captures show no horizontal overflow or header/content overlap.

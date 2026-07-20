# Mike v0.4.0 Frontend Baseline

This branch establishes the unmodified Mike frontend as Vera's new UI and
interaction baseline before branding, desktop integration, or Agent Task work.

## Source lock

- Repository: `https://github.com/Open-Legal-Products/mike.git`
- Tag: `v0.4.0`
- Commit: `dafac6b0a449a99c4280988e22feaf160eb6fbb9`
- Imported scope: `frontend/`
- License: `AGPL-3.0-only`

The import was performed from the fetched Git object rather than reconstructed
from screenshots or Figma. The existing Vera working directory and the archived
version A were not modified.

## Baseline routes

The upstream production build covers:

- Assistant and project-scoped Assistant
- Projects and project workspaces
- Library, files, and templates
- Tabular Reviews and project-scoped reviews
- Workflows and workflow detail surfaces
- Account, model, API key, connector, privacy, and security settings
- Login, signup, MFA verification, support, and not-found states

## Validation

Run the build with non-secret placeholders when a live Supabase instance is not
available:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=dummy-anon-key \
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 \
npm run build --prefix frontend
```

The placeholder values are only for compilation. Functional testing requires a
Mike-compatible backend and Supabase session.

The upstream production build passes. The upstream lint command currently
reports 23 errors and 40 warnings, primarily React 19
`react-hooks/set-state-in-effect` findings plus existing loose types. These are
recorded as upstream baseline debt and were not silently changed during the
source import.

The unauthenticated 1280 × 720 login baseline is stored at
`docs/screenshots/mike-v040-baseline/login-1280x720.png`.

The first Vera brand overlay keeps the Mike layout and interaction code intact
while replacing the visible product name and product mark. Its matching login
capture is stored at
`docs/screenshots/mike-v040-baseline/vera-login-1280x720.png`.

## Next changes

Changes after this baseline must be layered in this order:

1. Replace Mike brand assets and visible product names with Vera.
2. Add an API adapter boundary without changing the imported component layout.
3. Validate every upstream route and interaction against a live backend.
4. Add the thin Agent Task UI using Mike's existing component language.
5. Connect Agent Task UI to the thin Agent Kernel only after the mock flow is
   approved.

Version A remains the visual rollback reference and is not part of this source
replacement.

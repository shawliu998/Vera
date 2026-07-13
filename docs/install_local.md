# Install Aletheia Locally With Docker

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.**

This is the simplest way to run Aletheia on a local workstation. It starts:

- `frontend` on `http://localhost:3000`
- `backend` on `http://localhost:3001`
- a persistent Docker volume named `aletheia-data`

The Aletheia workflow uses local SQLite and filesystem storage only.

## Requirements

- Docker Desktop or Docker Engine with Docker Compose v2
- Git

## Quick Start

```bash
git clone https://github.com/shawliu998/Aletheia.git
cd Aletheia
cp .env.example .env
docker compose up --build
```

Then open:

```text
http://localhost:3000/aletheia
```

On the first empty local workspace, Docker seeds a local-only **Private
Contract Review Demo** matter. It includes a source document, retrieved evidence
items, generated issue/evidence/memo work products, a reviewer blocker,
review-derived eval data, approved export gates, audit/eval export files, and an
approved matter playbook. This gives reviewers a ready workspace without
uploading documents first.

You can also use the helper script:

```bash
./scripts/bootstrap-local.sh
```

## Data Persistence

Aletheia local data is stored in the Docker volume `aletheia-data` and mounted
inside the backend container at:

```text
/data/aletheia
```

That volume contains the local SQLite database, uploaded documents, indexes,
and exported audit/eval packages.

To stop containers without deleting data:

```bash
docker compose down
```

To delete local Aletheia Docker data:

```bash
docker compose down -v
```

## Configuration

The default `.env.example` uses:

```bash
ALETHEIA_AUTH_MODE=single_user
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ALETHEIA_DEMO_SEED_ENABLED=true
ALETHEIA_DEMO_SEED_MODE=empty
```

Set `ALETHEIA_DEMO_SEED_ENABLED=false` before first startup for a blank
workspace. Set `ALETHEIA_DEMO_SEED_MODE=always` only when you explicitly want to
add the bundled demo to a non-empty local workspace. The seed is idempotent and
will not create duplicate bundled demo matters in the same local volume.

For a local private-token mode, set all three values in `.env` before building:

```bash
ALETHEIA_AUTH_MODE=private_token
ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-a-random-local-private-token
NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-the-same-token-for-local-browser-only
```

Because `NEXT_PUBLIC_*` values are embedded into the frontend build, rebuild
after changing them:

```bash
docker compose up --build
```

## Health Checks

Backend health:

```bash
curl http://localhost:3001/health
```

Frontend:

```bash
open http://localhost:3000/aletheia
```

## Validation

The Docker local package has been validated with:

- clean-clone `docker compose config`
- clean-clone backend production build
- clean-clone frontend production build
- `docker compose build`
- `docker compose up -d`
- backend `GET /health` returning `{"ok":true}`
- frontend `/aletheia` returning HTTP 200
- a minimal browser smoke check confirming the Aletheia workspace renders
- first-start demo seed path for the V1 local workflow

## Scope

The Docker local install supports the V1 local/private-pilot workflow:

```text
ingestion -> retrieval -> evidence -> risk/memo -> review -> gates -> audit/export -> eval -> approved skill activation
```

Production SaaS, multi-user persistence, SSO, signed installer distribution,
and real external provider dispatch are not claimed by this local Docker
package.

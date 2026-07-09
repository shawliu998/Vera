# Retrieval Eval

Aletheia keeps retrieval changes behind a small local eval suite before ranking
behavior is expanded. The suite is deterministic and local-only.

Run it from the backend:

```bash
cd backend
npm run test:aletheia:retrieval-eval
```

The script creates two isolated matters in a temporary `.data` directory and
checks:

- default semantic retrieval fails closed unless explicitly enabled;
- keyword retrieval returns the expected source document;
- optional `local-json` semantic retrieval returns the expected source document;
- hybrid retrieval reports the configured local semantic layer;
- returned search results include rank, score direction, retrieval layers, and
  a plain-language ranking basis for audit review;
- matter-scoped search cannot see another matter's source chunks.

This is not a substitute for legal quality evals. It is the first regression
gate for retrieval policy, matter isolation, and source anchoring before the
`local-json` prototype is replaced or augmented with LanceDB/Qdrant.

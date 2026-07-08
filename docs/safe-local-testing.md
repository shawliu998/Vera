# Safe Local Testing

Aletheia should be tested with isolated local resources.

Use separate development credentials, buckets, databases, and model keys. Do not point local experiments at production data.

Recommended local checks:

- run the deterministic `/aletheia` demo without external API keys;
- use synthetic documents for upload testing;
- keep model provider keys in local environment files only;
- never commit `.env` files or production credentials.

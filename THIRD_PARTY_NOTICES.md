# Third-Party Notices

Vera is distributed under `AGPL-3.0-only`; see `LICENSE`.

## Open Legal Products Mike

Vera contains controlled source adaptations from Open Legal Products Mike:

```text
Repository: https://github.com/Open-Legal-Products/mike
Commit: e32daad5a4c64a5561e04c53ee12411e3c5e7238
License: AGPL-3.0-only
```

Source provenance, the approved adaptation rules, and affected areas are listed
in `docs/mike_port_manifest.md` and `docs/license_attribution.md`. Original
copyright and provenance comments must be retained.

## SQLCipher Node binding

Encrypted Workspace database mode uses `@signalapp/sqlcipher` 3.3.9, licensed
`AGPL-3.0-only` according to its installed package metadata. Its package license
is included with the installed dependency.

## Other dependencies and optional runtimes

JavaScript dependency versions are fixed by the repository lockfiles and carry
their own license metadata and distributed license files. The current Legacy
voice adapter can use an operator-provided faster-whisper installation and model;
neither that toolkit nor model weights are bundled or approved for redistribution
by this notice. The Legacy Word proof-of-concept references Microsoft's hosted
Office.js runtime and will undergo a separate terms and security review before
the target Word integration is released.

The maintained convergence inventory is
`docs/provenance/open-source-inventory.md`. Candidate projects listed there are
not incorporated merely because they were evaluated or mentioned.

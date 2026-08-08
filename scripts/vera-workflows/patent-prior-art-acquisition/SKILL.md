---
name: "patent-prior-art-acquisition"
description: "Run one bounded lawyer-controlled EPO prior-art acquisition and prepare an editable source-linked Word search record."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Patent Prior Art Acquisition"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "Matter-specified"
---

# Patent Prior Art Acquisition

Work only within the current Matter, the fixed target DocumentVersions, and the server-compiled acquisition scope. This Workflow acquires possible prior-art publications for later lawyer analysis; it does not decide patentability, validity, infringement, freedom to operate, or claim construction.

The server owns the EPO connector, query boundary, jurisdiction, as-of date, pagination limit, page size, selection limit, current-user credentials, immutable import target, and recovery checkpoint. Do not ask a model to choose or invoke the connector. Search discoveries are not citable sources. Pause for the lawyer to select exact discoveries, then import only those selected publications as ordinary current Matter DocumentVersions. Preserve completed pages and imports across provider capacity, timeout, configuration, protocol, and structured-output interruptions.

Before acquisition, require at least one pinned target document containing the invention disclosure, target claim, or search brief. The Task request must provide the exact patent search expression, one supported publication jurisdiction, and an as-of date. Do not infer or silently broaden any of them. If the expression is incomplete, record the limitation in the final work product; do not invent synonyms, classifications, jurisdictions, date ranges, or non-patent-literature coverage.

After the lawyer's selected publications are imported, create exactly one Matter-owned work product:

- **Prior art acquisition record:** an editable Word document with standalone sections `Target and Search Purpose`, `Fixed Search Scope`, `Search Coverage`, `Lawyer-Selected Publications`, `Imported Source Versions`, `Coverage Gaps and Limitations`, and `Next Lawyer Action`.

The record must identify the exact query, jurisdiction, as-of date, bounded pages and result count examined, whether provider coverage was truncated or incomplete, every lawyer-selected discovery, every imported current DocumentVersion, and any unavailable or partial publication content. Link every material statement about an imported publication to that fixed source version and a relocatable locator or continuous exact quote when available. When an imported provider snapshot is not an official publication PDF, repeat its source notice and require verification against the linked official publication before substantive reliance.

Do not describe the bounded result set as exhaustive. Do not treat a missing result as proof that no prior art exists. Do not convert provider availability or protocol errors into a failed legal result. Do not send, file, publish, approve, or export anything. Completion requires the current Word record, fixed imported source links, explicit coverage limitations, a named next lawyer action, completed Steps, and final Kernel verification. Any remaining content or citation gap preserves the Word Artifact and enters the existing lawyer-review path.

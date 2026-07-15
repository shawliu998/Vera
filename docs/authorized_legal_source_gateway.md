# Authorized Legal Source Gateway

This document defines Vera's controlled **enterprise API compatibility mode**.
It is not a claim that every legal-source provider exposes the same JSON API,
and it is not the preferred shape for every future integration. The
provider-by-provider technical and licensing decision is maintained in
[Legal Source Supplier Strategy](legal_source_supplier_strategy.md).

Vera does not scrape member sites or send Project material to a legal database.
An organization may use this gateway only when the provider or law firm has an
authorized API/data-service agreement and supplies a controlled HTTPS adapter
that implements the bounded protocol below. The adapter may translate Vera's
two compatibility operations into a documented private enterprise API.

Providers with an official public MCP, REST API, SDK, or data feed should
normally receive a provider-specific adapter after their production rights are
approved. They must not be forced through this JSON shape merely because the
legacy compatibility contract exists.

User-authorized manual file import is a local Project capability and does not
use this gateway.

## What this gateway does not authorize

The gateway is a transport boundary, not a licence. It must never proxy:

- browser scraping, page parsing, captured internal endpoints or session
  cookies;
- a personal or trial subscription that does not permit embedded or multi-user
  use;
- content whose cache, RAG, model-use, export or onward-distribution rights are
  undeclared;
- a public official website solely because it is authoritative or viewable in
  a browser.

Putting any of those behind an HTTPS service does not make the source
authorized. If the provider does not offer a documented interface or the
contract does not cover Vera's use, the provider remains unavailable.

## Deployment boundary

The desktop app and Compose deployment pass only these non-secret values to the
backend:

- `VERA_PKULAW_API_ENDPOINT`
- `VERA_PKULAW_API_ALLOWED_HOSTS`
- `VERA_PKULAW_API_CREDENTIAL_REF`
- `VERA_YUANDIAN_API_ENDPOINT`
- `VERA_YUANDIAN_API_ALLOWED_HOSTS`
- `VERA_YUANDIAN_API_CREDENTIAL_REF`
- `VERA_WOLTERS_API_ENDPOINT`
- `VERA_WOLTERS_API_ALLOWED_HOSTS`
- `VERA_WOLTERS_API_CREDENTIAL_REF`
- `VERA_OFFICIAL_LEGAL_API_ENDPOINT`
- `VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS`

The local wire is intentionally versioned as
`vera-legal-research-provider-v2` and
`vera-legal-source-provider-status-v2`, with integration type
`authorized_provider_adapter`. The bundled client rejects every other shape or
version instead of guessing across a partial desktop/backend upgrade.

Pkulaw, Yuandian and Wolters credentials are entered in Vera's local encrypted
provider store. They must never be placed in an environment file, browser
storage, or a Compose variable. The official-source compatibility adapter has
no credential field, but it still requires an operator-confirmed JSON API
endpoint and host allowlist.

These variables select a source-specific adapter or the enterprise
compatibility slot. Their presence does not prove a connection or production
licence. PKULaw MCP accepts only the audited law-semantic gateway URL copied
from the provider application page; YuanDian accepts only its fixed official
Open Platform host. Any other provider endpoint is valid only when a written
enterprise agreement supplies the exact protocol expected by the relevant
adapter. A public website URL must never be substituted for an API or MCP URL.

The National Laws and Regulations Database is an important authoritative
source, but Vera does not assume that its public website is a supported API. An
official website must not be configured as a gateway endpoint unless its
operator has published an automation interface with applicable terms or has
provided the deployment organization an authorized API agreement and protocol.

## Bounded enterprise compatibility protocol

This section applies only to separately contracted JSON/API gateways. It does
not describe the PKULaw MCP or YuanDian REST adapters, whose hosts, operations,
authentication and response schemas are source-specific and independently
audited.

Vera makes only one HTTPS `POST` request to the configured endpoint. Redirects,
custom ports, credential-bearing URLs, non-allowlisted response hosts, non-JSON
responses, oversized bodies and timeouts are rejected.

### Search

Request body:

```json
{ "operation": "search", "query": "民法典 买卖合同 解除通知" }
```

The gateway receives no Project ID, fact summary, document text, client name, or
conversation context. The request is made only after the lawyer has reviewed
and approved the exact redacted query in Vera.

Response body:

```json
{
  "results": [
    {
      "id": "provider-document-id",
      "title": "中华人民共和国民法典第五百六十三条",
      "summary": "可选的简短公开摘要",
      "url": "https://allowed.example/law/provider-document-id",
      "version": "2021-01-01",
      "effectiveDate": "2021-01-01",
      "effectiveTo": null,
      "publicationDate": "2020-05-28",
      "documentKind": "statute"
    }
  ]
}
```

### Fetch

Request body:

```json
{ "operation": "fetch", "documentId": "provider-document-id" }
```

Response body:

```json
{
  "document": {
    "id": "provider-document-id",
    "title": "中华人民共和国民法典第五百六十三条",
    "content": "完整、可复核的授权正文",
    "url": "https://allowed.example/law/provider-document-id",
    "version": "2021-01-01",
    "effectiveDate": "2021-01-01",
    "effectiveTo": null,
    "publicationDate": "2020-05-28",
    "documentKind": "statute"
  }
}
```

For cases, the enterprise adapter should also return `caseNumber` and only set
`caseVerificationStatus` to `verified` when the provider can verify the exact
case. Vera otherwise treats a case citation as unverified and blocks it from a
final research conclusion.

The normalized response is not evidence that Vera may retain or redistribute
every returned field. The deployment must separately declare the contract's
display, retention, model-use, export and onward-distribution policies. Missing
policy is fail-closed even when the request succeeds.

The v2 runtime wire currently projects only basis, retention, model use and
export. Display and onward-distribution remain mandatory external contract
evidence for production approval, but are not yet v2 runtime fields. The
code-owned production gate therefore remains closed; this document does not
claim those rights are already enforced in software.

## Acceptance before production use

1. Obtain the provider's written API/data authorization, field mapping and
   rights for display, cache, RAG/model use, export and onward distribution.
2. Confirm that the agreement covers the exact product, content licensors,
   users, territory and Vera deployment model.
3. Register only the controlled adapter and response hosts in the allowlist.
4. Configure the compatibility endpoint and credential reference through the
   deployment channel.
5. Enter the provider service secret through Vera's local encrypted settings
   surface. Never enter a member-site username, password or browser cookie.
6. Run a controlled non-client query, then verify that snapshots contain the
   correct URL, retrieval time, hash, version and effective-date fields.
7. Test expiry, deletion, provider withdrawal, model-use denial and export
   denial before testing a permitted path.
8. Run a complete Project with an attorney-approved redacted query, source
   retrieval, exact excerpts, citation Gate and reviewed work-product export.

If any step is unavailable, Vera must stay in `legal_source_unavailable`; it
must not fall back to browsing, scraping, or a model-generated citation.

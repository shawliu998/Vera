# Authorized Legal Source Gateway

Vera does not scrape member sites or send Matter material to a legal database.
For a commercial provider, the law firm or provider must supply an authorized
HTTPS gateway that implements the bounded protocol below. The gateway is the
place to translate Vera's two operations into the provider's documented API.

## Deployment boundary

The desktop app and Compose deployment pass only these non-secret values to the
backend:

- `VERA_PKULAW_API_ENDPOINT`
- `VERA_PKULAW_API_ALLOWED_HOSTS`
- `VERA_PKULAW_API_CREDENTIAL_REF`
- `VERA_WOLTERS_API_ENDPOINT`
- `VERA_WOLTERS_API_ALLOWED_HOSTS`
- `VERA_WOLTERS_API_CREDENTIAL_REF`
- `VERA_OFFICIAL_LEGAL_API_ENDPOINT`
- `VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS`

Pkulaw and Wolters credentials are entered in Vera's local encrypted provider
store. They must never be placed in an environment file, browser storage, or a
Compose variable. The official-source adapter has no credential field, but it
still requires an operator-confirmed JSON API endpoint and host allowlist.

The National Laws and Regulations Database is an important authoritative source,
but Vera does not assume that its public website is a supported API. An official
website must not be configured as a gateway endpoint unless its operator has
provided an authorized API agreement and protocol.

## Bounded protocol

Vera makes only one HTTPS `POST` request to the configured endpoint. Redirects,
custom ports, credential-bearing URLs, non-allowlisted response hosts, non-JSON
responses, oversized bodies and timeouts are rejected.

### Search

Request body:

```json
{ "operation": "search", "query": "民法典 买卖合同 解除通知" }
```

The gateway receives no Matter ID, fact summary, document text, client name, or
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

For cases, the gateway should also return `caseNumber` and only set
`caseVerificationStatus` to `verified` when the provider can verify the exact
case. Vera otherwise treats a case citation as unverified and blocks it from a
final research conclusion.

## Acceptance before production use

1. Obtain the provider's written API authorization and field mapping.
2. Register only its exact HTTPS hosts in the allowlist.
3. Configure the gateway endpoint and credential reference through the
   deployment channel.
4. Enter the provider secret through Vera's local encrypted settings surface.
5. Run a controlled non-client query, then verify that snapshots contain the
   correct URL, retrieval time, hash, version and effective-date fields.
6. Run a complete Matter with an attorney-approved redacted query, source
   download, exact excerpts, citation Gate and legal-opinion approval.

If any step is unavailable, Vera must stay in `legal_source_unavailable`; it
must not fall back to browsing, scraping, or a model-generated citation.

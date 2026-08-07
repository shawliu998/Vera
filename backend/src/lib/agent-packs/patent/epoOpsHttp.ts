export const EPO_OPS_HOST = "ops.epo.org";
const OPS_ENDPOINT = `https://${EPO_OPS_HOST}/3.2`;

export type EpoOpsCredentialsV1 = {
  consumerKey: string;
  consumerSecret: string;
};

export type EpoOpsSourcePrimitivesV1 = {
  getAccessToken(input: {
    credentials: EpoOpsCredentialsV1;
    signal: AbortSignal;
  }): Promise<{ accessToken: string; expiresInSeconds: number }>;
  searchBiblio(input: {
    accessToken: string;
    query: string;
    range: string;
    signal: AbortSignal;
  }): Promise<string>;
  readBiblio(input: {
    accessToken: string;
    publicationNumber: string;
    signal: AbortSignal;
  }): Promise<string>;
  readFullText(input: {
    accessToken: string;
    publicationNumber: string;
    signal: AbortSignal;
  }): Promise<{ descriptionXml: string | null; claimsXml: string | null }>;
};

export class EpoOpsHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`epo_ops_${operation}_${status}`);
    this.name = "EpoOpsHttpError";
  }
}

async function responseText(operation: string, url: string, init: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new EpoOpsHttpError(operation, response.status);
  return response.text();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const EPO_OPS_DEFAULT_PRIMITIVES: EpoOpsSourcePrimitivesV1 = {
  async getAccessToken({ credentials, signal }) {
    const response = await fetch(`${OPS_ENDPOINT}/auth/accesstoken`, {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${credentials.consumerKey}:${credentials.consumerSecret}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new EpoOpsHttpError("token", response.status);
    const payload = record(await response.json());
    const accessToken = String(payload.access_token ?? "").trim();
    const expiresInSeconds = Number(payload.expires_in);
    if (
      !accessToken ||
      accessToken.length > 4_096 ||
      !Number.isFinite(expiresInSeconds)
    ) {
      throw new Error("epo_ops_token_result_malformed");
    }
    return { accessToken, expiresInSeconds };
  },
  searchBiblio({ accessToken, query, range, signal }) {
    const url = new URL(
      `${OPS_ENDPOINT}/rest-services/published-data/search/biblio`,
    );
    url.searchParams.set("q", query);
    return responseText("search", url.toString(), {
      signal,
      headers: {
        Accept: "application/exchange+xml",
        Authorization: `Bearer ${accessToken}`,
        "X-OPS-Range": range,
      },
    });
  },
  readBiblio({ accessToken, publicationNumber, signal }) {
    return responseText(
      "biblio",
      `${OPS_ENDPOINT}/rest-services/published-data/publication/epodoc/${encodeURIComponent(publicationNumber)}/biblio`,
      {
        signal,
        headers: {
          Accept: "application/exchange+xml",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
  },
  async readFullText({ accessToken, publicationNumber, signal }) {
    const base = `${OPS_ENDPOINT}/rest-services/published-data/publication/epodoc/${encodeURIComponent(publicationNumber)}`;
    const readPart = async (part: "description" | "claims") => {
      try {
        return await responseText(part, `${base}/${part}`, {
          signal,
          headers: {
            Accept: "application/fulltext+xml",
            Authorization: `Bearer ${accessToken}`,
          },
        });
      } catch (error) {
        if (error instanceof EpoOpsHttpError && error.status === 404) return null;
        throw error;
      }
    };
    const [descriptionXml, claimsXml] = await Promise.all([
      readPart("description"),
      readPart("claims"),
    ]);
    return { descriptionXml, claimsXml };
  },
};

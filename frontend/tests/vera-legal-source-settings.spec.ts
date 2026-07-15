import { expect, test } from "@playwright/test";

type ProviderOptions = {
  hasSecret: boolean;
  endpointConfigured?: boolean;
  allowlisted?: boolean;
  credentialReferenceConfigured?: boolean;
  encryptionEnabled?: boolean;
  declaredPolicy?: boolean;
  fetchFullText?: boolean;
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function providerStatus(
  provider: "pkulaw" | "yuandian" | "wolters",
  input: ProviderOptions,
) {
  const endpointConfigured = input.endpointConfigured ?? true;
  const allowlisted = input.allowlisted ?? true;
  const credentialReferenceConfigured =
    input.credentialReferenceConfigured ?? true;
  const encryptionEnabled = input.encryptionEnabled ?? true;
  const deploymentReady =
    endpointConfigured && allowlisted && credentialReferenceConfigured;
  const reason = !endpointConfigured
    ? "endpoint_missing"
    : !allowlisted
      ? "endpoint_not_allowlisted"
      : !credentialReferenceConfigured
        ? "credential_reference_missing"
        : !input.declaredPolicy
          ? "data_use_policy_undeclared"
          : !encryptionEnabled
            ? "secret_storage_unavailable"
            : !input.hasSecret
              ? "credential_unavailable"
              : null;
  return {
    provider,
    deploymentReady,
    endpointConfigured,
    allowlisted,
    credentialReferenceConfigured,
    hasSecret: input.hasSecret,
    encryptionEnabled,
    contractVersion: "vera-legal-research-provider-v2",
    integration: "authorized_provider_adapter",
    capabilities: {
      search: true,
      fetchFullText: input.fetchFullText ?? true,
      pagination: false,
      getByCitation: false,
      jurisdictionFilter: false,
      asOfDateFilter: false,
      structuredFilters: false,
      dynamicToolInvocation: false,
      requiresExplicitEgressApproval: true,
      documentKinds:
        input.fetchFullText === false
          ? ["statute", "judicial_interpretation", "other"]
          : ["statute", "judicial_interpretation", "case", "other"],
    },
    dataUsePolicy: input.declaredPolicy
      ? {
          basis: "deployment_contract",
          retention: "full_text_ttl",
          export: "exact_quotes_only",
          modelUse: "local_only",
        }
      : {
          basis: "not_declared",
          retention: "not_declared",
          export: "not_declared",
          modelUse: "not_declared",
        },
    connectionStatus: reason
      ? { state: "unavailable", reason, connectionTested: false }
      : {
          state: "configured_unverified",
          reason: null,
          connectionTested: false,
        },
  };
}

function providerResponse(pkulawHasSecret: boolean, woltersHasSecret: boolean) {
  return {
    schemaVersion: "vera-legal-source-provider-status-v2",
    localOnly: true,
    detail: "Authorized legal-source deployment and credential status.",
    providers: [
      providerStatus("pkulaw", {
        hasSecret: pkulawHasSecret,
        declaredPolicy: true,
        fetchFullText: false,
      }),
      providerStatus("yuandian", {
        hasSecret: false,
      }),
      providerStatus("wolters", {
        hasSecret: woltersHasSecret,
        endpointConfigured: false,
        allowlisted: false,
      }),
    ],
  };
}

test("Mike Legal Sources is write-only, truthful, removable while deployment is unavailable, and responsive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  let pkulawHasSecret = false;
  let woltersHasSecret = true;
  let initialGet = true;
  const initial = deferred();
  const initialStarted = deferred();
  const save = deferred();
  const saveStarted = deferred();
  const remove = deferred();
  const removeStarted = deferred();
  const legalRequests: Array<{
    method: string;
    url: string;
    body: string | null;
  }> = [];
  const providerHostRequests: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/pkulaw|yuandian|chineselaw|wolters/i.test(url.hostname)) {
      providerHostRequests.push(request.url());
    }
  });

  await page.route("**/aletheia/providers**", async (route) => {
    const request = route.request();
    legalRequests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    });
    if (request.method() === "GET") {
      if (initialGet) {
        initialGet = false;
        initialStarted.release();
        await initial.promise;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          providerResponse(pkulawHasSecret, woltersHasSecret),
        ),
      });
      return;
    }
    if (request.method() === "PUT") {
      saveStarted.release();
      await save.promise;
      pkulawHasSecret = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          providerStatus("pkulaw", {
            hasSecret: true,
            declaredPolicy: true,
          }),
        ),
      });
      return;
    }
    if (request.method() === "DELETE") {
      removeStarted.release();
      await remove.promise;
      woltersHasSecret = false;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.abort();
  });

  const navigation = page.goto("/settings/legal-sources");
  await initialStarted.promise;
  await expect(page.getByText("正在读取本地法律数据源状态。")).toBeVisible();
  initial.release();
  await navigation;

  await expect(
    page.getByRole("button", { name: "法律数据源" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "法律数据源", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText(/不等于“已连接”/)).toBeVisible();
  await expect(page.getByRole("button", { name: /测试连接/ })).toHaveCount(0);

  const pkulaw = page.getByTestId("legal-source-provider-pkulaw");
  const yuandian = page.getByTestId("legal-source-provider-yuandian");
  const wolters = page.getByTestId("legal-source-provider-wolters");
  await expect(pkulaw).toContainText("不可用");
  await expect(pkulaw).toContainText("全文限时保留");
  await expect(pkulaw).toContainText("以下内容来自部署契约");
  await expect(pkulaw).toContainText("仅检索，不取回全文");
  await expect(pkulaw).toContainText("法律法规、司法解释、其他");
  await expect(yuandian).toContainText("元典");
  await expect(yuandian).toContainText("可检索并取回全文");
  await expect(yuandian).toContainText("案例");
  await expect(wolters).toContainText("部署未配置授权端点");

  const pkulawInput = pkulaw.getByLabel("新密钥");
  const woltersInput = wolters.getByLabel("新密钥");
  await expect(pkulawInput).toBeEnabled();
  await expect(woltersInput).toBeDisabled();
  await expect(wolters.getByRole("button", { name: "移除密钥" })).toBeEnabled();

  const secret = "write-once-local-secret";
  await pkulawInput.fill(secret);
  await pkulaw.getByRole("button", { name: "安全保存" }).click();
  await saveStarted.promise;
  await expect(pkulawInput).toHaveValue("");
  await expect(
    pkulaw.getByRole("button", { name: "正在保存…" }),
  ).toHaveAttribute("aria-busy", "true");
  save.release();
  await expect(pkulaw).toContainText("已配置但未验证");
  await expect(pkulaw).toContainText("当前状态已重新读取");

  await wolters.getByRole("button", { name: "移除密钥" }).click();
  const confirmation = page.getByText("移除本地密钥？").locator("..");
  await expect(confirmation).toContainText("威科先行");
  const confirmRemove = confirmation.getByRole("button", {
    name: "移除密钥",
  });
  await confirmRemove.click();
  await removeStarted.promise;
  await expect(confirmRemove).toHaveAttribute("aria-busy", "true");
  remove.release();
  await expect(wolters).toContainText("本地密钥已移除");
  await expect(
    wolters.getByRole("button", { name: "移除密钥" }),
  ).toBeDisabled();

  expect(
    legalRequests.some(({ url }) =>
      /\/providers\/[^/]+\/test(?:\?|$)/.test(url),
    ),
  ).toBe(false);
  expect(providerHostRequests).toEqual([]);
  const put = legalRequests.find(({ method }) => method === "PUT");
  expect(put?.url).toMatch(/\/aletheia\/providers\/pkulaw\/secret$/);
  expect(put?.body).toBe(JSON.stringify({ secret }));
  expect(
    legalRequests.some(
      ({ method, url }) =>
        method === "DELETE" &&
        /\/aletheia\/providers\/wolters\/secret$/.test(url),
    ),
  ).toBe(true);

  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test("Legal Sources exposes a bounded load failure and real retry", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/aletheia/providers**", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "LOCAL_CONTROL_ERROR",
          detail: "Local provider status is unavailable.",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerResponse(false, false)),
    });
  });

  await page.goto("/settings/legal-sources");
  const failure = page.getByText("法律数据源状态不可用").locator("..");
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "重试" }).click();
  await expect(page.getByTestId("legal-source-provider-pkulaw")).toBeVisible();
  expect(attempts).toBe(2);
});

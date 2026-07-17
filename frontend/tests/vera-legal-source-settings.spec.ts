import { expect, test } from "@playwright/test";

const PROVIDER_ID = "018f3b20-7788-7abc-8def-0123456789ab";
const PROVIDER_SCHEMA = "vera-workspace-legal-provider-hub-v1";

type ProviderOverrides = Partial<ReturnType<typeof providerProfile>>;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function providerProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ID,
    provider: "yuandian",
    endpoint_set_id: "yuandian-official-mcp-v1",
    enabled: false,
    credential_configured: false,
    usage_policy: {
      retention: "not_declared",
      local_processing: "transient_only",
      model_use: "prohibited_pending_authorization",
      export: "prohibited_pending_authorization",
    },
    capabilities: [
      { capability: "law", enabled: true },
      { capability: "case", enabled: true },
      { capability: "company", enabled: false },
    ],
    revision: 1,
    connection_revision: 1,
    credential_revision: 1,
    connection_test: null,
    status: "not_configured",
    ...overrides,
  };
}

function providersResponse(profiles: readonly ProviderOverrides[]) {
  return {
    schema_version: PROVIDER_SCHEMA,
    providers: profiles,
  };
}

function providerResponse(profile: ProviderOverrides) {
  return {
    schema_version: PROVIDER_SCHEMA,
    profile,
  };
}

function passedConnectionTest() {
  return {
    status: "passed",
    error_code: null,
    retryable: false,
    latency_ms: 42,
    tested_at: "2026-07-16T01:02:03.004Z",
  };
}

test("YuanDian Legal Sources is write-only, gate-truthful, removable, and responsive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const initial = deferred();
  const initialStarted = deferred();
  const save = deferred();
  const saveStarted = deferred();
  const remove = deferred();
  const removeStarted = deferred();
  let initialGet = true;
  let currentProfile = providerProfile();
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

  await page.route("**/legal-providers**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    legalRequests.push({ method, url, body: request.postData() });

    if (method === "GET") {
      if (initialGet) {
        initialGet = false;
        initialStarted.release();
        await initial.promise;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providersResponse([])),
      });
      return;
    }

    if (method === "POST" && /\/legal-providers\/yuandian$/.test(url)) {
      currentProfile = providerProfile();
    } else if (method === "PUT" && /\/credential$/.test(url)) {
      saveStarted.release();
      await save.promise;
      currentProfile = providerProfile({
        credential_configured: true,
        revision: 2,
        connection_revision: 2,
        credential_revision: 2,
        status: "configured_unverified",
      });
    } else if (method === "POST" && /\/test$/.test(url)) {
      currentProfile = providerProfile({
        credential_configured: true,
        revision: 3,
        connection_revision: 3,
        credential_revision: 2,
        connection_test: passedConnectionTest(),
        status: "activation_gate_closed",
      });
    } else if (method === "POST" && /\/enable$/.test(url)) {
      currentProfile = providerProfile({
        enabled: true,
        credential_configured: true,
        revision: 4,
        connection_revision: 3,
        credential_revision: 2,
        connection_test: passedConnectionTest(),
        status: "activation_gate_closed",
      });
    } else if (method === "POST" && /\/disable$/.test(url)) {
      currentProfile = providerProfile({
        credential_configured: true,
        revision: 5,
        connection_revision: 3,
        credential_revision: 2,
        connection_test: passedConnectionTest(),
        status: "activation_gate_closed",
      });
    } else if (method === "DELETE" && /\/credential$/.test(url)) {
      removeStarted.release();
      await remove.promise;
      currentProfile = providerProfile({
        revision: 6,
        connection_revision: 6,
        credential_revision: 6,
      });
    } else {
      await route.abort();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerResponse(currentProfile)),
    });
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
  await expect(page.getByText("尚未配置元典法律数据源")).toBeVisible();
  await page.getByRole("button", { name: "配置元典" }).click();

  const provider = page.getByTestId("legal-source-provider-yuandian");
  await expect(provider).toBeVisible();
  await expect(provider).toContainText("元典");
  await expect(provider).toContainText("yuandian-official-mcp-v1");
  await expect(provider).toContainText("法律法规检索");
  await expect(provider).toContainText("案例检索");
  await expect(provider).toContainText("企业信息（非法律权威来源）");
  await expect(provider).toContainText("仅瞬时处理，不持久化 Provider 内容");
  await expect(provider).toContainText("禁止");
  await expect(provider).toContainText("未配置");
  await expect(
    provider.getByRole("button", { name: "测试连接" }),
  ).toBeDisabled();
  await expect(
    provider.getByRole("button", { name: "启用配置" }),
  ).toBeDisabled();
  await expect(
    provider.getByRole("button", { name: "移除密钥" }),
  ).toBeDisabled();

  const secret = "write-once-local-secret";
  const secretInput = provider.getByLabel("新密钥");
  await secretInput.fill(secret);
  await provider.getByRole("button", { name: "安全保存" }).click();
  await saveStarted.promise;
  await expect(secretInput).toHaveValue("");
  await expect(
    provider.getByRole("button", { name: "安全保存" }),
  ).toBeDisabled();
  save.release();
  await expect(provider).toContainText("本地服务已安全保存密钥");
  await expect(provider).toContainText("已配置但未验证");

  await provider.getByRole("button", { name: "测试连接" }).click();
  await expect(provider).toContainText("当前连接版本测试通过");
  await expect(provider).toContainText("生产启用门禁关闭");
  await expect(provider.getByText("已就绪", { exact: true })).toHaveCount(0);
  await expect(
    provider.getByRole("button", { name: "启用配置" }),
  ).toBeEnabled();

  await provider.getByRole("button", { name: "启用配置" }).click();
  await expect(provider).toContainText("Provider 配置已启用");
  await expect(provider).toContainText("生产门禁状态仍独立判定");
  await provider.getByRole("button", { name: "停用配置" }).click();
  await expect(provider).toContainText("Provider 配置已停用");

  await provider.getByRole("button", { name: "移除密钥" }).click();
  const confirmation = page.getByText("移除本地密钥？").locator("..");
  await expect(confirmation).toContainText("元典");
  const confirmRemove = confirmation.getByRole("button", {
    name: "移除密钥",
  });
  await confirmRemove.click();
  await removeStarted.promise;
  await expect(confirmRemove).toHaveAttribute("aria-busy", "true");
  remove.release();
  await expect(provider).toContainText("本地密钥已移除");
  await expect(
    provider.getByRole("button", { name: "移除密钥" }),
  ).toBeDisabled();

  expect(providerHostRequests).toEqual([]);
  expect(legalRequests.map(({ method }) => method)).toEqual([
    "GET",
    "POST",
    "PUT",
    "POST",
    "POST",
    "POST",
    "DELETE",
  ]);
  expect(legalRequests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/api/v1/legal-providers",
    "/api/v1/legal-providers/yuandian",
    `/api/v1/legal-providers/${PROVIDER_ID}/credential`,
    `/api/v1/legal-providers/${PROVIDER_ID}/test`,
    `/api/v1/legal-providers/${PROVIDER_ID}/enable`,
    `/api/v1/legal-providers/${PROVIDER_ID}/disable`,
    `/api/v1/legal-providers/${PROVIDER_ID}/credential`,
  ]);
  expect(JSON.parse(legalRequests[2]!.body!)).toEqual({
    expected_revision: 1,
    secret,
  });
  expect(JSON.parse(legalRequests[3]!.body!)).toEqual({ expected_revision: 2 });
  expect(JSON.parse(legalRequests[4]!.body!)).toEqual({ expected_revision: 3 });
  expect(JSON.parse(legalRequests[5]!.body!)).toEqual({ expected_revision: 4 });
  expect(JSON.parse(legalRequests[6]!.body!)).toEqual({ expected_revision: 5 });

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
  await page.route("**/legal-providers**", async (route) => {
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
      body: JSON.stringify(providersResponse([providerProfile()])),
    });
  });

  await page.goto("/settings/legal-sources");
  const failure = page.getByText("法律数据源状态不可用").locator("..");
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "重试" }).click();
  await expect(
    page.getByTestId("legal-source-provider-yuandian"),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

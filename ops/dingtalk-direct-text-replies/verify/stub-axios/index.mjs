// Offline axios boundary stub for verifying the patched @dingtalk-real-ai/dingtalk-connector.
//
// The connector routes every DingTalk call through axios instances created in
// dist/http-client-*.mjs. This stub replaces the axios package in the scratch
// install so no request leaves the process: each call is recorded into
// globalThis.__DT_MOCK_HTTP__.calls and answered from the route table below.
// One-shot failure injection is available via state.failOnce.set("POST <url>", script)
// with script = { throw: true, message } for transport errors or
// { body: { errcode: 310000, errmsg: "..." } } for HTTP-200 business errors.

const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: {} });

const state = () => {
  if (!globalThis.__DT_MOCK_HTTP__) {
    globalThis.__DT_MOCK_HTTP__ = { calls: [], failOnce: new Map() };
  }
  return globalThis.__DT_MOCK_HTTP__;
};

async function respond(method, url, data) {
  const s = state();
  const urlText = String(url);
  const call = { method, url: urlText, body: data, seq: s.calls.length };
  s.calls.push(call);

  const script = s.failOnce.get(`${method} ${urlText}`);
  if (script) {
    s.failOnce.delete(`${method} ${urlText}`);
    if (script.throw) throw new Error(script.message || "mock transport failure");
    return ok(script.body ?? { errcode: 310000, errmsg: "mock business failure" });
  }

  if (/\/v1\.0\/oauth2\/accessToken$/.test(urlText)) {
    return ok({ accessToken: "mock-api-token", expireIn: 7200 });
  }
  if (/oapi\.dingtalk\.com\/gettoken/.test(urlText)) {
    return ok({ errcode: 0, access_token: "mock-oapi-token", expires_in: 7200 });
  }
  if (/\/v1\.0\/card\/instances$/.test(urlText) && method === "POST") {
    return ok({ success: true, result: { cardInstanceId: `mock-card-${call.seq}` } });
  }
  if (/\/v1\.0\/card\/instances\/deliver$/.test(urlText)) {
    return ok({
      success: true,
      result: {
        success: true,
        deliverResults: [{ success: true, carrierId: `mock-carrier-${call.seq}` }],
      },
    });
  }
  if (/\/v1\.0\/card\/(streaming|instances)/.test(urlText)) {
    return ok({ success: true, result: "Success" });
  }
  if (/\/v1\.0\/robot\/oToMessages\/batchSend$/.test(urlText)) {
    return ok({ processQueryKey: `mock-otomsg-${call.seq}` });
  }
  if (/\/v1\.0\/robot\/groupMessages\/send$/.test(urlText)) {
    return ok({ processQueryKey: `mock-groupmsg-${call.seq}` });
  }
  // Session webhook and any other endpoint: delivered successfully.
  return ok({ errcode: 0 });
}

const makeInstance = () => {
  const instance = {
    post: (url, data) => respond("POST", url, data),
    put: (url, data) => respond("PUT", url, data),
    get: (url) => respond("GET", url, undefined),
    delete: (url) => respond("DELETE", url, undefined),
    request: (config) =>
      respond((config?.method || "get").toUpperCase(), config?.url, config?.data),
    interceptors: {
      request: { use: () => 0, eject: () => {} },
      response: { use: () => 0, eject: () => {} },
    },
    defaults: { headers: {} },
  };
  return instance;
};

const axios = { create: () => makeInstance(), ...makeInstance() };
export default axios;
export { axios };
export const isAxiosError = () => false;

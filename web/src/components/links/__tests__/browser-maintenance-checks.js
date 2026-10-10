/** Disposable loopback replay of production Workspace, preview panel and shared transport. */
export async function runF5IntentBrowserChecks() {
  if (location.origin !== "http://127.0.0.1:41973") throw new Error("fixture_only");
  const checks = [], pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const until = async (fn, label) => { const end = performance.now() + 10000;
    while (performance.now() < end) { const value = await fn(); if (value) return value; await pause(); } throw new Error(`timeout: ${label}`); };
  const button = (name) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  const click = async (name) => { (await until(() => { const b = button(name); return b && !b.disabled && b; }, name)).click(); await pause(); };
  const state = async () => (await (await fetch("/__test/state")).json()).data;
  const scenario = (body) => fetch("/__test/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!button("Refresh")) await click("Toggle test language");
  await scenario({ reset: true, maintenance: true, submission: true }); await click("Refresh");
  await until(() => document.querySelector('main [aria-busy="false"]'), "idle");
  const before = structuredClone((await state()).links);
  await click("Maintenance preview");
  const port = await until(() => document.querySelector('form[aria-label="Preview endpoint changes"] [name="carrier_port"]'), "port");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(port, "26002");
  port.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  await click("Generate preview");
  await until(() => button("Save maintenance plan (no cutover)"), "explicit save");
  check(document.body.textContent.includes("no port reservation, key generation or execution"), "save action explicitly promises only durable intent");
  await click("Save maintenance plan (no cutover)");
  await until(() => button("Cancel maintenance plan"), "persisted cancel");
  check(document.body.textContent.includes("Awaiting executor (no automatic cutover)"), "history does not fabricate a successful cutover");
  check(document.body.textContent.includes("Maintenance plan saved; no cutover has executed."), "write notice separates saved intent from execution");
  let snapshot = await state();
  const commits = snapshot.calls.filter((c) => c.method === "POST" && c.path.endsWith("/maintenance/migrations"));
  check(commits.length === 1 && Object.keys(commits[0].body).length === 5 && commits[0].workspaceId === 5
    && /^[0-9a-f-]{36}$/.test(commits[0].body.idempotency_key), "save uses canonical UUID, receipt, scope and version/generation CAS");
  check(JSON.stringify(snapshot.links) === JSON.stringify(before), "save leaves actual fixture desired versions, bindings and deployments unchanged");
  const blocked = [...document.querySelectorAll("button")].filter((b) => ["Add rule", "Deploy", "Edit"].includes(b.textContent.trim()));
  check(blocked.length > 0 && blocked.every((b) => b.disabled), "pending intent disables conflicting detail actions");
  await click("Toggle test permission");
  await until(() => !button("Cancel maintenance plan"), "read-only history");
  check(document.body.textContent.includes("Awaiting executor (no automatic cutover)"), "read-only actor retains scoped history without a cancellation control");
  await click("Toggle test permission"); await until(() => button("Cancel maintenance plan"), "permission restored");
  await click("Switch test workspace");
  await until(() => !document.body.textContent.includes("Awaiting executor (no automatic cutover)"), "scope isolation");
  check(!button("Cancel maintenance plan"), "another workspace never sees or cancels the previous plan");
  await click("Switch test workspace"); await until(() => button("Cancel maintenance plan"), "scope restored");
  await click("Cancel maintenance plan");
  await until(() => document.body.textContent.includes("Plan cancelled") && !button("Cancel maintenance plan"), "cancelled history");
  snapshot = await state();
  const cancellation = snapshot.calls.filter((c) => c.path.endsWith("/cancel")).at(-1);
  check(cancellation.method === "POST" && cancellation.workspaceId === 5 && cancellation.body.expected_state_version === 1, "cancel sends the persisted state CAS through the same transport");
  check(document.body.textContent.includes("Maintenance plan cancelled; the running Link is unchanged."), "cancel notice never promises runtime teardown");
  check(JSON.stringify(snapshot.links) === JSON.stringify(before), "cancellation releases intent only, not existing fixture ownership");
  return { passed: checks.length, checks };
}

export async function runF5BrowserChecks() {
  if (location.origin !== "http://127.0.0.1:41973") throw new Error("fixture_only");
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, label) => {
    const end = performance.now() + 10000;
    while (performance.now() < end) { const value = predicate(); if (value) return value; await pause(); }
    throw new Error(`timeout: ${label}`);
  };
  const button = (name, scope = document) => [...scope.querySelectorAll("button")].find((el) => el.textContent.trim() === name);
  const click = async (name, scope = document) => { (await until(() => { const el = button(name, scope); return el && !el.disabled && el; }, name)).click(); await pause(); };
  const fill = async (selector, value, scope = document) => {
    const el = await until(() => scope.querySelector(selector), selector);
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await pause();
  };
  const scenario = (body) => fetch("/__test/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch("/__test/state")).json()).data;
  const idle = () => until(() => document.querySelector('main [aria-busy="false"]'), "idle");
  const refresh = async () => { await click("Refresh"); await idle(); };
  const previewForm = () => document.querySelector('form[aria-label="Preview endpoint changes"],form[aria-label="Preview key rotation"]');
  const result = () => document.querySelector('section[aria-label="Read-only maintenance plan"]');
  const open = async () => {
    if (!previewForm()) await click("Maintenance preview");
    await until(previewForm, "preview form");
  };
  const close = async () => { if (button("Close preview")) await click("Close preview"); };
  const generate = async () => { await click("Generate preview", previewForm()); };
  const changePort = () => fill('[name="carrier_port"]', 26002, previewForm());
  const previewCalls = (s) => s.calls.filter((c) => c.path.endsWith("/maintenance/preview"));
  const text = () => document.querySelector("main").textContent;
  const noWriteNotice = () => !text().includes("Request completed; status reloaded.") && !text().includes("Endpoints saved.");

  await scenario({ reset: true, maintenance: true }); await click("Toggle test language"); await refresh(); await open();
  check(button("Edit endpoints").disabled && button("Rotate key").disabled, "live endpoint/key writes remain locked with desired suspended references");
  check(previewForm().getAttribute("aria-label") === "Preview endpoint changes" && !button("Save", previewForm()), "endpoint form is explicitly preview-only");
  const before = structuredClone((await state()).links);
  await changePort(); await generate(); await until(result, "endpoint result");
  check(JSON.stringify((await state()).links) === JSON.stringify(before), "endpoint preview makes no persisted change");
  check(result().textContent.includes("Desired enabled references: 1") && result().textContent.includes("Desired suspended references (still included): 1"), "reference counts explicitly mean desired state, not live counts");
  check(result().textContent.includes("Live TCP connections and UDP mappings are both unknown") && result().textContent.includes("no ports are reserved"), "unknown live counts and unchecked/unreserved ports remain explicit");
  check(result().textContent.includes("Maintenance execution is unsupported") && result().querySelectorAll("button").length === 0, "planning stages have no execution control");
  check(result().textContent.includes("Desired-suspended rules may still carry old deployed traffic"), "desired suspension never proves no old traffic");
  check(noWriteNotice(), "preview success never fabricates saved/submitted/deployed notice");
  const request = previewCalls(await state()).at(-1);
  check(request.method === "POST" && request.workspaceId === 5 && request.body.expected_version === 2 && request.body.expected_generation === 4
    && request.body.change.config.carrier_port === 26002, "production shared request sends explicit workspace/operation and version/generation CAS");
  await fill('[name="carrier_port"]', 26003, previewForm()); check(!result(), "input change clears preview immediately");
  await fill('[name="carrier_port"]', "", previewForm());
  const count = previewCalls(await state()).length; previewForm().requestSubmit(); await pause();
  check(previewCalls(await state()).length === count, "invalid endpoint inputs do not send HTTP");
  await changePort(); await generate(); await until(result, "new preview");
  await fill('select:not([name])', "rotate_key", previewForm().parentElement);
  check(!result() && previewForm().getAttribute("aria-label") === "Preview key rotation", "operation change clears endpoint result");
  await generate(); await until(result, "rotation preview");
  check(previewCalls(await state()).at(-1).body.change.type === "rotate_key" && result().textContent.includes("Planned key rotation (not rotated)"), "key preview requests rotation without rotating or exposing keys");
  check(JSON.stringify((await state()).links) === JSON.stringify(before), "key preview makes no persisted change");

  for (const code of ["link_version_conflict", "link_generation_conflict", "permission_denied", "link_maintenance_preview_too_large", "fxp_links_not_enabled"]) {
    await close(); await scenario({ previewError: code }); await open(); await changePort();
    const reads = (await state()).calls.filter((c) => c.method === "GET").length;
    await generate(); await until(() => text().includes(code), code);
    check(!result() && noWriteNotice(), `${code}: safe error without preview/write success`);
    check((await state()).calls.filter((c) => c.method === "GET").length === reads, `${code}: failure never performs write follow-up reload`);
    if (code === "link_maintenance_preview_too_large") check(text().includes("500 references, 2048 held ports"), "oversized graph has safe bounded bilingual hint");
  }
  await close(); await scenario({ previewError: "link_generation_conflict", previewDelay: true }); await open(); await changePort(); await generate();
  await click("Edit forwarding rule");
  const editor = await until(() => document.querySelector('form[aria-label="Edit forwarding rule"]'), "unrelated editor");
  await fill('[name="name"]', "Keep unrelated draft", editor);
  await until(() => text().includes("link_generation_conflict"), "late preview failure");
  check(editor.isConnected && editor.querySelector('[name="name"]').value === "Keep unrelated draft", "preview error does not close or reset unrelated binding editor");
  await click("Cancel", editor); await close();

  for (const tamper of ["workspace", "live", "secret"]) {
    await scenario({ previewTamper: tamper }); await open(); await changePort(); await generate();
    if (tamper === "secret") {
      await until(result, "closed secret projection"); check(!text().includes("NEVER_RENDER_THIS_SECRET"), "secret transport extras never render");
    } else {
      await until(() => text().includes("invalid_link_response"), "invalid projection"); check(!result(), `${tamper} forged preview rejected by shared API projection`);
    }
    await close();
  }
  await scenario({ previewLifetime: 500 }); await open(); await changePort(); await generate(); await until(result, "short-lived preview");
  await until(() => !result() && text().includes("The preview expired"), "preview expiry");
  check(!result(), "expiry drops cached preview before the next 15s poll"); await close();

  for (const advance of ["version", "generation", "revision", "remove"]) {
    await scenario({ maintenance: true }); await refresh(); await open(); await changePort(); await generate(); await until(result, "snapshot preview");
    await scenario({ advance }); await refresh(); check(!result(), `${advance} reload invalidates snapshot and references`); await close();
  }
  for (const failure of [false, true]) {
    await scenario({ maintenance: true, previewDelay: true, ...(failure ? { previewError: "link_generation_conflict" } : {}) });
    await refresh(); await open(); await changePort(); await generate(); await refresh(); await pause(1400);
    check(!result() && !text().includes("link_generation_conflict") && noWriteNotice(), `reload fences late preview ${failure ? "error" : "success"}`); await close();
  }
  await scenario({ maintenance: true, previewDelay: true }); await refresh(); await open(); await changePort(); await generate();
  await fill('select:not([name])', "rotate_key", previewForm().parentElement); await pause(1400);
  check(!result() && previewForm().getAttribute("aria-label") === "Preview key rotation", "operation switch fences in-flight endpoint success"); await close();
  for (const failure of [false, true]) {
    await scenario({ maintenance: true, maintenanceSecond: true, previewDelay: true, ...(failure ? { previewError: "link_generation_conflict" } : {}) });
    await refresh(); await open(); await changePort(); await generate(); await fill("#links-selected", 4); await idle(); await pause(1400);
    check(!result() && !previewForm() && !text().includes("link_generation_conflict") && noWriteNotice(), `link selection fences late preview ${failure ? "error" : "success"}`);
    await fill("#links-selected", 3); await idle();
    await open(); await changePort(); await generate(); await close(); await pause(1400);
    check(!result() && !previewForm() && !text().includes("link_generation_conflict"), `close fences late preview ${failure ? "error" : "success"}`);
  }

  for (const control of ["Switch test workspace", "Toggle test permission"]) {
    await scenario({ maintenance: true, previewDelay: true, previewError: "link_generation_conflict" }); await refresh(); await open(); await changePort(); await generate();
    await click(control); await idle(); await pause(1400);
    check(!result() && !previewForm() && !text().includes("link_generation_conflict") && noWriteNotice(), `${control} fences in-flight result/error and clears preview scope`);
    await click(control); await idle();
  }
  await scenario({ maintenance: true }); await refresh(); await open(); await changePort(); await generate(); await until(result, "bilingual preview");
  await click("Toggle test language"); await idle();
  await click("维护预览");
  const zhForm = await until(() => document.querySelector('form[aria-label="预览端点变更"]'), "Chinese preview form");
  await fill('[name="carrier_port"]', 26002, zhForm); await click("生成预览", zhForm);
  const zhResult = await until(() => document.querySelector('section[aria-label="只读维护方案"]'), "Chinese result");
  check(zhResult.textContent.includes("期望暂停引用") && zhResult.textContent.includes("维护执行尚不支持") && zhResult.textContent.includes("尚未检查可用性"), "Chinese result preserves desired/reference/execution/port caveats");
  await click("Toggle test permission"); await idle();
  check(!button("维护预览") && !document.querySelector('section[aria-label="只读维护方案"]'), "node:read alone cannot preview or retain a privileged result");
  return { passed: checks.length, checks };
}

/** Uses the actual production 15s polling interval, not a substituted timer. Fresh Chinese harness required. */
export async function runF5PollingDraftChecks() {
  if (location.origin !== "http://127.0.0.1:41973") throw new Error("fixture_only");
  const checks = [], pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, label) => {
    const end = performance.now() + 20000;
    while (performance.now() < end) { const value = await predicate(); if (value) return value; await pause(); }
    throw new Error(`timeout: ${label}`);
  };
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const button = (name) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === name && !b.disabled);
  const click = async (name) => { (await until(() => button(name), name)).click(); await pause(); };
  const fill = async (el, value) => {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await pause();
  };
  const scenario = (body) => fetch("/__test/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch("/__test/state")).json()).data;
  const reads = async () => (await state()).calls.filter((c) => c.path === "/api/links/3" && c.method === "GET").length;
  const idle = () => until(() => document.querySelector('main [aria-busy="false"]'), "idle");
  const result = () => document.querySelector('section[aria-label="Read-only maintenance plan"]');
  await scenario({ reset: true, maintenance: true }); await click("Toggle test language"); await click("Refresh"); await idle();
  await click("Maintenance preview");
  const form = await until(() => document.querySelector('form[aria-label="Preview endpoint changes"]'), "draft endpoint form");
  await fill(form.querySelector('[name="carrier_port"]'), 26003); await click("Generate preview"); await until(result, "draft result");
  let baseline = await reads(); await scenario({ advance: "revision" });
  await until(async () => await reads() > baseline, "actual 15s revision poll"); await idle();
  check(form.isConnected && form.querySelector('[name="carrier_port"]').value === "26003", "15s polling preserves the same entered endpoint draft form");
  check(!result(), "periodic revision change immediately invalidates the old result");
  const op = form.parentElement.querySelector('select:not([name])');
  await fill(op, "rotate_key"); await click("Generate preview"); await until(result, "key result");
  baseline = await reads(); await scenario({ advance: "generation" });
  await until(async () => await reads() > baseline, "actual 15s generation poll"); await idle();
  check(op.isConnected && op.value === "rotate_key" && document.querySelector('form[aria-label="Preview key rotation"]'), "15s polling preserves the chosen preview operation");
  check(!result(), "periodic generation change immediately invalidates the old result");
  await fill(op, "update_endpoints");
  const next = document.querySelector('form[aria-label="Preview endpoint changes"]');
  await fill(next.querySelector('[name="carrier_port"]'), 26004); await click("Generate preview"); await until(result, "manual refresh result");
  await click("Refresh"); await idle();
  check(!result() && next.isConnected && next.querySelector('[name="carrier_port"]').value === "26004", "manual refresh fences result without destroying the endpoint draft");
  return { passed: checks.length, checks };
}

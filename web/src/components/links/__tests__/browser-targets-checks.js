/** Run in the isolated loopback browser fixture: (await import('/__test/f2-checks.js')).runF2BrowserChecks(). */
export async function runF2BrowserChecks() {
  if (location.origin !== "http://127.0.0.1:41973") throw new Error("fixture_only");
  const passed = [];
  const check = (value, label) => { if (!value) throw new Error(label); passed.push(label); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const until = async (predicate, label) => {
    const end = performance.now() + 10000;
    while (performance.now() < end) { const value = predicate(); if (value) return value; await pause(); }
    throw new Error(`timeout: ${label}`);
  };
  const buttons = (scope = document) => [...scope.querySelectorAll("button")];
  const button = (name, scope = document) => buttons(scope).find((el) => el.textContent.trim() === name);
  const click = async (name, scope = document) => {
    const el = await until(() => button(name, scope) && !button(name, scope).disabled && button(name, scope), name);
    el.click(); await pause();
  };
  const fill = async (selector, value, scope = document) => {
    const el = await until(() => scope.querySelector(selector), selector);
    const prototype = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, String(value));
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    await pause();
  };
  const scenario = (body) => fetch("/__test/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch("/__test/state")).json()).data;
  const idle = () => until(() => document.querySelector('main [aria-busy="false"]'), "idle");
  const form = () => document.querySelector('form[aria-label="添加转发规则"],form[aria-label="编辑转发规则"]');
  const save = async () => { await click("保存", form()); await until(() => !form(), "editor closes"); await idle(); };
  const refresh = async () => { await click("刷新"); await idle(); };
  const article = (name) => [...document.querySelectorAll("article")].find((el) => el.getAttribute("aria-label") === name);
  const targetSection = (name) => article(name)?.querySelector('section[aria-label="目标集"]');
  const health = (name) => [...(targetSection(name)?.querySelectorAll("dt") ?? [])]
    .filter((el) => el.textContent === "目标健康").map((el) => el.nextElementSibling.textContent);

  await scenario({ reset: true }); await refresh();
  await click("创建 FXP 隧道");
  const configForm = await until(() => document.querySelector('form[aria-label="创建 FXP 隧道"]'), "create form");
  await fill('[name="name"]', "F2 browser fixture", configForm);
  await fill('[name="ingress_node_id"]', 11, configForm); await fill('[name="egress_node_id"]', 12, configForm);
  await fill('[name="carrier_port"]', 26001, configForm); await click("保存", configForm);
  await until(() => button("添加转发规则"), "created tunnel"); await idle();
  await click("添加转发规则");
  check(!form().querySelector('[name="target_set_enabled"]').checked && !form().querySelector('[name="target_strategy"]'), "new form defaults to legacy opt-in");
  await fill('[name="name"]', "Rule A", form()); await fill('[name="listen_port"]', 24001, form());
  await fill('[name="protocol"]', "udp", form());
  form().querySelector('[name="target_set_enabled"]').click(); await pause();
  check(form().querySelector('[name="target_probe"]').value === "none", "UDP defaults to no probe");
  await fill('[name="protocol"]', "both", form());
  check(form().querySelector('[name="target_probe"]').value === "tcp", "both defaults to TCP probe");
  await fill('[name="protocol"]', "udp", form()); await fill('[name="target_probe"]', "tcp", form());
  check(form().textContent.includes("辅助 TCP 探测不证明 UDP 可用"), "auxiliary TCP and UDP silence warning");
  await fill('[data-target-index="0"] [name="target_host"]', "127.0.0.1", form());
  await fill('[data-target-index="0"] [name="target_port"]', 25001, form());
  await click("添加目标 (1/10)", form());
  await fill('[data-target-index="1"] [name="target_host"]', "127.0.0.2", form());
  await fill('[data-target-index="1"] [name="target_port"]', 25002, form());
  form().querySelector('[aria-label="上移 (1)"]').click(); await pause();
  check(form().querySelector('[data-target-index="0"] [name="target_host"]').value === "127.0.0.2", "moving preserves values and order");
  for (let count = 2; count < 10; count++) await click(`添加目标 (${count}/10)`, form());
  check(button("添加目标 (10/10)", form()).disabled, "maximum ten targets enforced by UI");
  for (let index = 9; index > 1; index--) { form().querySelector(`[aria-label="删除目标 (${index})"]`).click(); await pause(); }
  await fill('[name="target_strategy"]', "random", form());
  await fill('[name="target_failure_seconds"]', 10, form()); await fill('[name="target_recover_seconds"]', 3600, form());
  check(form().textContent.includes("现有连接可能中断"), "shared session change warning retained");
  await fill('[data-target-index="1"] [name="target_host"]', "127.0.0.2", form());
  await fill('[data-target-index="1"] [name="target_port"]', 25002, form());
  const beforeInvalid = (await state()).calls.filter((call) => call.method === "POST" && call.path.endsWith("/forwards")).length;
  await click("保存", form());
  await until(() => form()?.querySelector('[role="alert"]'), "duplicate validation");
  check((await state()).calls.filter((call) => call.method === "POST" && call.path.endsWith("/forwards")).length === beforeInvalid, "duplicate targets rejected before any request");
  for (const host of ["server\\path", "www.example.com:443", "[::1]", "2001:db8:::1"]) {
    await fill('[data-target-index="1"] [name="target_host"]', host, form());
    await click("保存", form());
    await until(() => form()?.querySelector('[role="alert"]'), "invalid address");
    check((await state()).calls.filter((call) => call.method === "POST" && call.path.endsWith("/forwards")).length === beforeInvalid, `invalid host rejected without request: ${host}`);
  }
  await fill('[data-target-index="1"] [name="target_host"]', "2001:db8::1", form());
  check(form().querySelector('[data-target-index="1"] [name="target_host"]').value === "2001:db8::1", "raw IPv6 input is preserved without brackets");
  await fill('[data-target-index="1"] [name="target_host"]', "127.0.0.1", form());
  await fill('[data-target-index="1"] [name="target_port"]', 25001, form());
  await save();
  let snapshot = await state(); let a = snapshot.links[0].forwards[0];
  check(a.target_set.targets.length === 2 && a.remote_host === "127.0.0.2" && a.remote_port === 25002
    && a.target_set.strategy === "random" && a.target_set.probe === "tcp"
    && a.target_set.failure_seconds === 10 && a.target_set.recover_seconds === 3600, "create sends ordered complete set and first fields");
  check(health("Rule A").every((value) => value === "未知"), "missing target observation is unknown despite runtime Ready");

  await click("添加转发规则"); await fill('[name="name"]', "Rule B", form());
  await fill('[name="listen_port"]', 24002, form()); await fill('[name="target_host"]', "127.0.0.3", form());
  await fill('[name="target_port"]', 25003, form()); await save();
  const bBefore = JSON.stringify((await state()).links[0].forwards[1]);
  check(!(await state()).links[0].forwards[1].target_set, "legacy rule remains editable without a target set");
  await click("编辑转发规则", article("Rule A"));
  check(form().querySelector('[type="checkbox"][name="target_set_enabled"]').disabled
    && form().querySelector('[name="target_strategy"]').value === "random"
    && form().querySelector('[name="target_recover_seconds"]').value === "3600", "editing retains all set options and prevents legacy downgrade");
  form().querySelector('[aria-label="删除目标 (0)"]').click(); await pause();
  check(form().querySelector('[aria-label="删除目标 (0)"]').disabled, "last target cannot be deleted");
  await save(); snapshot = await state(); a = snapshot.links[0].forwards[0];
  const update = snapshot.calls.filter((call) => call.method === "PUT" && call.path.endsWith(`/forwards/${a.id}`)).at(-1);
  check(a.target_set.version === 1 && a.target_set.targets.length === 1 && a.remote_host === "127.0.0.1"
    && update.body.expected_revision === 1 && update.body.binding.target_host === a.target_set.targets[0].host, "deleting first rewrites first fields and submits one-item set with CAS");
  check(JSON.stringify(snapshot.links[0].forwards[1]) === bBefore, "editing A preserves B configuration and revision");
  await click("编辑转发规则", article("Rule B")); await fill('[name="name"]', "Rule B legacy edited", form());
  await fill('[name="target_host"]', "2001:db8::1", form()); await save();
  check(!(await state()).links[0].forwards[1].target_set, "legacy edit does not implicitly opt in");
  check((await state()).links[0].forwards[1].remote_host === "2001:db8::1", "raw IPv6 submits with separate port");

  await click("编辑转发规则", article("Rule A")); await scenario({ conflict: true });
  await fill('[name="name"]', "conflicting name", form()); await save();
  check(document.querySelector('[role="alert"]').textContent.includes("重新读取并打开编辑表单"), "CAS conflict closes stale editor and requests reload");
  await scenario({}); await refresh();
  await click("编辑转发规则", article("Rule A")); await fill('[name="name"]', "Rule A revised", form()); await save();
  snapshot = await state(); a = snapshot.links[0].forwards[0];
  check(snapshot.calls.filter((call) => call.method === "PUT").at(-1).body.expected_revision === a.config_revision - 1, "reopened edit uses refreshed revision");
  await scenario({ targetsCapabilityMissing: true }); await click("编辑转发规则", article("Rule A revised")); await save();
  check(document.querySelector('[role="alert"]').textContent.includes("forward.targets.fxp.v1"), "missing capability explains upgrade for both nodes");
  await scenario({}); await refresh();

  // Observations are seeded independently from mutations, including the backend's stripped payloads.
  for (const observation of ["healthy", "all_unavailable", "stale", "digest_mismatch", "expired", "missing", "ingress_only", "not_ready", "old_checked", "future_checked", "initial_unknown", "probe_none_silent", "probe_none"]) {
    await scenario({ targetObservation: observation }); await refresh();
    const expected = observation === "all_unavailable" ? "故障" : ["healthy", "probe_none"].includes(observation) ? "健康" : "未知";
    await until(() => health("Rule A revised").length === 1 && health("Rule A revised").every((value) => value === expected), `egress ${observation}`);
    const values = health("Rule A revised");
    check(values.length === 1 && values.every((value) => value === expected), `egress ${observation}: ${expected}`);
    if (observation === "all_unavailable") check(targetSection("Rule A revised").textContent.includes("全部目标不可用"), "observation reason shown beside health");
    if (observation === "healthy") check(targetSection("Rule A revised").textContent.includes("最近选中索引不代表所有现有会话"), "last chosen is not all session current target");
    if (observation === "healthy" || observation === "probe_none") {
      const snapshot = await state();
      const checkedAt = snapshot.links[0].deployment.placements.find((p) => p.role === "egress").observation.target_status[0].last_checked_at;
      const clockNow = Date.now;
      try {
        // Advance only the isolated page clock; no minute-long wait and no response re-fetch.
        Date.now = () => Date.parse(checkedAt) + 60_001;
        await until(() => health("Rule A revised").every((value) => value === "未知"), "cached health expires");
        check(!targetSection("Rule A revised").textContent.includes(checkedAt)
          && article("Rule A revised").textContent.includes("目标健康"), observation === "probe_none"
          ? "passive none health still expires through the freshness gate"
          : "cached healthy expires at 60s without waiting for lease or reload");
      } finally { Date.now = clockNow; }
      await until(() => health("Rule A revised").every((value) => value === "健康"), "fixture clock restored");
    }
  }
  await scenario({ targetObservation: "healthy" }); await refresh();
  await click("Toggle test language");
  await until(() => document.querySelector('section[aria-label="Target set"]'), "English copy");
  check(document.body.textContent.includes("No active probe") && document.body.textContent.includes("actual TCP connection results or UDP replies")
    && document.body.textContent.includes("UDP silence remains unknown") && document.body.textContent.includes("Auxiliary TCP probing does not prove UDP availability"), "English passive health evidence and UDP silence copy");
  await click("Toggle test permission");
  await until(() => !button("Edit forwarding rule"), "read-only");
  check(!button("Add forwarding rule") && document.querySelector('section[aria-label="Target set"]'), "read-only keeps observation detail and removes mutations");
  await click("Toggle test permission"); await click("Toggle test language"); await idle();
  return { passed: passed.length, checks: passed, fixture: location.origin };
}

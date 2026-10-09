/** Disposable loopback fixture only; imports production UI and shared HTTP transport. */
export async function runF3BrowserChecks() {
  if (location.origin !== "http://127.0.0.1:41973") throw new Error("fixture_only");
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const until = async (predicate, label) => {
    const end = performance.now() + 10000;
    while (performance.now() < end) { const value = predicate(); if (value) return value; await pause(); }
    throw new Error(`timeout: ${label}`);
  };
  const button = (name, scope = document) => [...scope.querySelectorAll("button")].find((el) => el.textContent.trim() === name);
  const click = async (name, scope = document) => { (await until(() => { const el = button(name, scope); return el && !el.disabled && el; }, name)).click(); await pause(); };
  const fill = async (selector, value, scope = document) => {
    const el = await until(() => scope.querySelector(selector), selector);
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await pause();
  };
  const scenario = (body) => fetch("/__test/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch("/__test/state")).json()).data;
  const idle = () => until(() => document.querySelector('main [aria-busy="false"]'), "idle");
  const form = () => document.querySelector('form[aria-label="Add forwarding rule"],form[aria-label="Edit forwarding rule"]');
  const field = (name) => form().querySelector(`[name="${name}"]`);
  const toggle = async (name) => { field(name).click(); await pause(); };
  const refresh = async () => { await click("Refresh"); await idle(); };
  const save = async () => { await click("Save", form()); await until(() => !form(), "editor closed"); await idle(); };
  const article = (name) => [...document.querySelectorAll("article")].find((el) => el.getAttribute("aria-label") === name);
  const sourceSection = (name) => article(name)?.querySelector('section[aria-label="Declared client source policy"]');
  const source = { version: 1, receive_proxy: true, trusted_cidrs: ["192.0.2.0/24", "2001:db8::/32"], send_proxy: "v2" };
  const off = { version: 1, receive_proxy: false, trusted_cidrs: [], send_proxy: "off" };

  // The replay starts on the freshly loaded Chinese harness, with management allowed.
  await scenario({ reset: true }); await click("Toggle test language"); await refresh();
  await click("Create FXP tunnel");
  const config = await until(() => document.querySelector('form[aria-label="Create FXP tunnel"]'), "config form");
  await fill('[name="name"]', "F3 browser fixture", config);
  await fill('[name="ingress_node_id"]', 11, config); await fill('[name="egress_node_id"]', 12, config);
  await fill('[name="carrier_port"]', 26001, config); await click("Save", config);
  await until(() => button("Add forwarding rule"), "created tunnel"); await idle();
  await click("Add forwarding rule");
  check(!field("client_source_enabled").checked && !field("send_proxy"), "new legacy source controls are opt-in");
  await fill('[name="protocol"]', "both", form());
  check(field("client_source_enabled").disabled && !field("send_proxy"), "both has no active source controls");
  await fill('[name="protocol"]', "udp", form()); await toggle("target_set_enabled");
  check(field("client_source_enabled").disabled && field("target_strategy").querySelector('[value="ip_hash"]').disabled, "UDP disables source and IP hash");
  await fill('[name="protocol"]', "tcp", form());
  check(field("target_strategy").querySelector('[value="ip_hash"]').disabled, "TCP alone does not enable IP hash");
  await fill('[name="name"]', "Source A", form()); await fill('[name="listen_port"]', 24001, form());
  await fill('[name="target_host"]', "127.0.0.1", form()); await fill('[name="target_port"]', 25001, form());
  await click("Add target (1/10)", form());
  const item1 = form().querySelector('[data-target-index="1"]');
  await fill('[name="target_host"]', "127.0.0.2", item1); await fill('[name="target_port"]', 25002, item1);
  await toggle("client_source_enabled");
  check(!field("target_strategy").querySelector('[value="ip_hash"]').disabled && field("trusted_cidrs").disabled, "explicit socket policy enables IP hash without PROXY sending");
  await fill('[name="target_strategy"]', "ip_hash", form());
  await fill('[name="protocol"]', "both", form());
  check(field("protocol").value === "tcp" && form().textContent.includes("blocks protocol changes"), "source protocol change is blocked with a clear error");
  await toggle("client_source_enabled");
  check(field("client_source_enabled").checked && form().textContent.includes("IP hash requires TCP"), "new IP hash cannot silently lose its source policy");
  await toggle("receive_proxy");
  check(field("trusted_cidrs").required && !field("trusted_cidrs").disabled, "receive requires trusted CIDRs");
  const emptyCalls = (await state()).calls.length;
  await click("Save", form());
  check(!field("trusted_cidrs").validity.valid && (await state()).calls.length === emptyCalls, "empty required trust blocks submit before HTTP");
  for (const trusted of ["0.0.0.0/0", "::/0", "::ffff:192.0.2.1/128", "upstream.internal/24", Array(33).fill("192.0.2.0/24").join("\n")]) {
    const before = (await state()).calls.length;
    await fill('[name="trusted_cidrs"]', trusted, form()); await click("Save", form());
    check(!!form().querySelector('[role="alert"]') && (await state()).calls.length === before, `unsafe trust rejected before HTTP: ${trusted.slice(0, 25)}`);
  }
  await fill('[name="trusted_cidrs"]', "192.0.2.123/24\n2001:0DB8::9/32", form()); await fill('[name="send_proxy"]', "v2", form());
  await click("Move up", item1); await save();
  let snapshot = await state(); let a = snapshot.links[0].forwards[0];
  check(JSON.stringify(a.client_source) === JSON.stringify(source) && a.target_set.strategy === "ip_hash", "create submits canonical complete source with IP hash");
  check(a.remote_host === "127.0.0.2" && a.remote_port === 25002 && a.target_set.targets[0].host === a.remote_host, "create preserves ordered first-target projection");
  check(sourceSection("Source A").textContent.includes("Trusted upstream PROXY source") && sourceSection("Source A").textContent.includes("PROXY v2"), "detail declares trust and send mode");
  check(sourceSection("Source A").textContent.includes("not observed client identity") && sourceSection("Source A").textContent.includes("108 bytes") && sourceSection("Source A").textContent.includes("536 total bytes"), "policy is not source health; strict limits are explained");
  check(article("Source A").textContent.includes("Pool membership") && article("Source A").textContent.includes("healthy eligible"), "IP-hash remapping caveat includes pool and health");

  await click("Add forwarding rule"); await fill('[name="name"]', "Legacy B", form());
  await fill('[name="listen_port"]', 24002, form()); await fill('[name="target_host"]', "127.0.0.3", form()); await fill('[name="target_port"]', 25003, form()); await save();
  check(!(await state()).links[0].forwards[1].client_source, "legacy create stays omitted");
  const bBefore = JSON.stringify((await state()).links[0].forwards[1]);
  await click("Edit forwarding rule", article("Source A"));
  check(field("client_source_enabled").checked && field("receive_proxy").checked && field("send_proxy").value === "v2" && field("trusted_cidrs").value.includes("2001:db8::/32"), "edit loads full known source policy");
  check(field("protocol").disabled, "edit retains existing protocol fence");
  const expectedRevision = (await state()).links[0].forwards[0].config_revision;
  await click("Remove target", form().querySelector('[data-target-index="0"]')); await save();
  snapshot = await state(); a = snapshot.links[0].forwards[0];
  const update = snapshot.calls.filter((c) => c.method === "PUT").at(-1);
  check(update.body.expected_revision === expectedRevision && JSON.stringify(update.body.binding.client_source) === JSON.stringify(source), "edit roundtrips full policy with captured CAS");
  check(a.target_set.targets.length === 1 && a.remote_host === "127.0.0.1" && a.remote_port === 25001, "delete first target updates first projection under IP hash");
  check(JSON.stringify(snapshot.links[0].forwards[1]) === bBefore, "source edits preserve other rules and revisions");
  await click("Edit forwarding rule", article("Source A")); await fill('[name="send_proxy"]', "v1", form()); await save();
  check((await state()).links[0].forwards[0].client_source.send_proxy === "v1" && sourceSection("Source A").textContent.includes("PROXY v1"), "edit supports declared PROXY v1 mode");
  await click("Edit forwarding rule", article("Source A")); await fill('[name="send_proxy"]', "off", form()); await save();
  check((await state()).links[0].forwards[0].target_set.strategy === "ip_hash" && sourceSection("Source A").textContent.includes("Do not send PROXY"), "send off keeps internal source IP-hash selection");
  await click("Edit forwarding rule", article("Source A")); await toggle("client_source_enabled");
  check(!!field("client_source_present") && !field("send_proxy") && !field("target_strategy").querySelector('[value="ip_hash"]').disabled, "known source opt-out stays explicit, with IP hash eligible");
  await save();
  check(JSON.stringify((await state()).links[0].forwards[0].client_source) === JSON.stringify(off) && sourceSection("Source A").textContent.includes("Entry client socket source"), "known source disabling submits explicit all-off and declares socket source");
  await click("Edit forwarding rule", article("Legacy B")); await fill('[name="name"]', "Legacy B edited", form()); await save();
  check(!(await state()).links[0].forwards[1].client_source, "legacy edit never implicitly opts in");

  for (const [code, text] of [["link_client_source_required", "cannot omit"], ["agent_fxp_source_capability_missing", "forward.client-source.fxp.v1"], ["client_source_tcp_only", "TCP only"], ["ip_hash_requires_client_source", "IP hash requires TCP"]]) {
    await scenario({ sourceError: code }); await click("Edit forwarding rule", article("Source A")); await save();
    const alert = document.querySelector('main [role="alert"]');
    check(alert?.textContent.includes(text) && alert.querySelector("details") && !alert.querySelector("details").open, `safe actionable collapsed API error: ${code}`);
    await scenario({}); await refresh();
  }
  await scenario({ conflict: true }); await click("Edit forwarding rule", article("Source A")); await save();
  check(document.querySelector('main [role="alert"]').textContent.includes("Reload"), "source edit conflict closes old captured editor");
  await scenario({}); await refresh(); await click("Edit forwarding rule", article("Source A")); await save();
  snapshot = await state();
  check(snapshot.calls.filter((c) => c.method === "PUT").at(-1).body.expected_revision === snapshot.links[0].forwards[0].config_revision - 1, "reopened source edit uses fresh CAS");
  await click("Toggle test language"); await idle();
  check(document.querySelectorAll('section[aria-label]').length && document.body.textContent.includes("PROXY"), "bilingual policy survives remount");
  await click("Toggle test permission"); await idle();
  check([...document.querySelectorAll("article")].every((el) => !el.querySelector("button"))
    && !document.querySelector("form") && !!article("Source A")?.querySelector("section"), "read-only retains source details without controls");
  await click("Toggle test permission"); await click("Toggle test language"); await idle();
  await scenario({ delay: true }); await click("Edit forwarding rule", article("Source A"));
  await click("Save", form()); await click("Switch test workspace"); await pause();
  await until(() => !article("Source A") && !form(), "workspace invalidates source editor");
  await new Promise((resolve) => setTimeout(resolve, 1600)); await idle();
  check(!article("Source A") && !form(), "late source mutation cannot cross workspace fence");
  await scenario({}); await click("Switch test workspace"); await idle();
  return { passed: checks.length, checks, fixture: location.origin };
}

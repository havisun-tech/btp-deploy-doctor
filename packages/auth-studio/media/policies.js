// Auth Studio, AMS policies view. Renders state from the extension host; actions go back as messages.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let tab = saved.tab || 'roles';
  let state;
  let findings = [];
  let report;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const attr = (o) => esc(JSON.stringify(o));
  const send = (msg) => vscode.postMessage(msg);
  const no = '<span class="bad" title="no">✗</span>';
  const link = (file, line, label) => `<a href="#" data-open="${attr({ file, line })}">${esc(label ?? `${file}:${line}`)}</a>`;
  const btn = (label, msg, cls = '') => `<button class="${cls}" data-msg="${attr(msg)}">${esc(label)}</button>`;
  const policyLink = (name) => {
    const p = state.policies.find((x) => x.qualified === name);
    return p ? link(p.file, p.line, name) : esc(name);
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      state = m.state;
      findings = m.findings;
    }
    if (m.type === 'tokenReport') report = m.report;
    if (m.type === 'tab') setTab(m.tab);
    render();
  });

  function setTab(t) {
    tab = t;
    vscode.setState({ tab });
  }

  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-msg],[data-open],[data-tab],[data-token]');
    if (!el) return;
    e.preventDefault();
    if (el.dataset.tab) {
      setTab(el.dataset.tab);
      return render();
    }
    if (el.dataset.open) return send({ type: 'open', ...JSON.parse(el.dataset.open) });
    if (el.dataset.token === 'explain') return send({ type: 'token', token: document.getElementById('token').value });
    if (el.dataset.token === 'clear') {
      report = undefined;
      return render();
    }
    send(JSON.parse(el.dataset.msg));
  });

  function render() {
    if (!state) return;
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const tabs = [
      ['roles', 'Roles'],
      ['policies', `Policies (${state.policies.length})`],
      ['attributes', 'Attributes'],
      ['checks', `Checks${findings.length ? ` (${findings.length})` : ''}`],
      ['token', 'Token'],
    ];
    const keepToken = document.getElementById('token')?.value || '';
    app.innerHTML = `
      <header>
        <div>
          <h1>Auth Studio · AMS policies</h1>
          <div class="muted">${esc(state.root)} · ${esc(state.dclRoot)} · ${state.files.length} DCL file${state.files.length === 1 ? '' : 's'}</div>
        </div>
        <div class="actions">
          ${errors ? `<span class="badge bad">${errors} error${errors > 1 ? 's' : ''}</span>` : ''}
          ${warnings ? `<span class="badge warn">${warnings} warning${warnings > 1 ? 's' : ''}</span>` : ''}
          ${!errors && !warnings ? '<span class="badge ok">No problems</span>' : ''}
        </div>
      </header>
      ${!state.files.length ? `<div class="banner">No DCL files in <code>${esc(state.dclRoot)}</code> yet. ${state.generates.policies ? '"cds build" generates <code>basePolicies.dcl</code> and <code>schema.dcl</code> from the CDS model; ' : ''}to set up AMS, run <code>cds add ams</code>. ${btn('Run cds add ams…', { type: 'addAms' }, 'secondary')}</div>` : ''}
      <nav role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'active' : ''}" data-tab="${id}">${esc(label)}</button>`).join('')}</nav>
      <main>${view()}</main>`;
    const t = document.getElementById('token');
    if (t) t.value = keepToken;
  }

  function view() {
    switch (tab) {
      case 'policies': return policiesView();
      case 'attributes': return attributesView();
      case 'checks': return checksView();
      case 'token': return tokenView();
      default: return rolesView();
    }
  }

  function rolesView() {
    if (!state.roles.length) return `<section><p class="muted">No roles found in @requires or @restrict annotations (${esc(state.cdsFiles)} .cds files scanned).</p></section>`;
    const hasFix = (role) => findings.some((f) => f.ruleId === 'AMS001' && f.title.startsWith(`Role "${role}" `) && f.fixes.length);
    const rows = state.roles
      .map((r) => {
        const given = [
          ...r.direct.map((d) => `<div>${link(d.file, d.line, d.policy)}${d.condition ? ` <span class="muted">where ${esc(d.condition)}</span>` : ''}</div>`),
          ...r.derived.map((d) => `<div>${link(d.file, d.line, d.policy)} <span class="tag" title="Builds on a policy above with USE">derived</span></div>`),
        ].join('');
        // A policy that assigns a misspelling of this role (AMS002) explains why none gives it.
        const typo = findings.find((f) => f.ruleId === 'AMS002' && f.fixes.some((t) => t.endsWith(` to "${r.role}"`)));
        const none = state.generates.policies
          ? '<span class="muted">"cds build" will generate a policy</span>'
          : typo
            ? `${no} <span class="bad">${esc(typo.title.replace(/^Policy /, ''))}</span> ${link(typo.file, typo.line, 'show')}`
            : `${no} <span class="bad">No policy gives this role</span>`;
        return `<tr>
          <td><b>${esc(r.role)}</b></td>
          <td>${link(r.file, r.line)}</td>
          <td>${given || none}</td>
          <td>${!given && typo && !state.generates.policies ? btn('Fix the role name', { type: 'applyFix', i: typo.i, fix: 0 }) : !given && hasFix(r.role) ? btn('Add policy', { type: 'addPolicy', role: r.role }) : ''}</td>
        </tr>`;
      })
      .join('');
    return `
      <section>
        <h2>Roles in your CDS model</h2>
        <p class="hint">CAP checks these role names. With AMS, users get them through policies (<code>ASSIGN ROLE</code>) that an administrator assigns in the Identity Authentication admin console. A role no policy gives fails every request with 403 Forbidden.</p>
        <table>
          <thead><tr><th>CDS role</th><th>Used in</th><th>Policies that give it</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${state.generates.policies ? '' : `<p class="hint">New policies go to <code>${esc(state.baseFile)}</code>. "cds build" does not regenerate that file once it exists.</p>`}
      </section>`;
  }

  function policiesView() {
    if (!state.policies.length) return '<section><p class="muted">No policies yet.</p></section>';
    const byPkg = new Map();
    for (const p of state.policies) {
      if (!byPkg.has(p.pkg)) byPkg.set(p.pkg, []);
      byPkg.get(p.pkg).push(p);
    }
    const cdsRoles = new Set(state.roles.map((r) => r.role));
    const kindTag = (k) => (k === 'internal' ? ' <span class="tag" title="For technical users and API access (ias_apis); not assignable to people">internal</span>' : k === 'default' ? ' <span class="tag" title="Applies to every user">default</span>' : '');
    const card = (p) => {
      const lines = [
        ...p.roles.map((r) => `<li>Assigns role ${cdsRoles.has(r.role) || !cdsRoles.size ? `<b>${esc(r.role)}</b>` : `<span class="ref bad" title="The CDS model does not use this role">${esc(r.role)}</span>`}${r.condition ? ` <span class="muted">where ${esc(r.condition)}</span>` : ''}</li>`),
        ...p.uses.map((u) => `<li>Uses ${u.known ? policyLink(u.target) : `<span class="ref bad" title="No such policy">${esc(u.ref)}</span>`}${u.restrict ? ` <span class="muted">restricted to ${esc(u.restrict)}</span>` : ''}</li>`),
        ...p.grants.map((g) => `<li>Grants <b>${esc(g.actions.join(', '))}</b> on ${esc(g.resources.join(', '))}${g.condition ? ` <span class="muted">where ${esc(g.condition)}</span>` : ''}</li>`),
      ];
      return `<div class="finding">
        <div><b>${link(p.file, p.line, p.qualified)}</b>${kindTag(p.kind)}${p.label ? ` <span class="muted">${esc(p.label)}</span>` : ''}</div>
        ${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}
        <ul class="plain">${lines.join('') || '<li class="muted">Empty policy</li>'}</ul>
        ${p.usedBy.length ? `<div class="muted">Used by ${p.usedBy.map(policyLink).join(', ')}</div>` : ''}
      </div>`;
    };
    return [...byPkg.entries()]
      .map(([pkg, list]) => `<section><h2>${pkg ? `Package ${esc(pkg)}` : 'DCL root'}</h2>${list.map(card).join('')}</section>`)
      .join('');
  }

  function attributesView() {
    const rows = state.attributes
      .map((a) => `<tr>
        <td><b>${a.line && state.schemaFile ? link(state.schemaFile, a.line, a.path) : esc(a.path)}</b></td>
        <td>${a.inSchema ? esc(a.type || 'from CDS') : `${no} <span class="bad">missing from schema</span>`}</td>
        <td>${a.mappedFrom ? `${link(a.mappedFrom.file, a.mappedFrom.line, a.mappedFrom.element)}` : '<span class="muted">not mapped</span>'}</td>
        <td>${a.usedBy.length ? a.usedBy.map(policyLink).join(', ') : '<span class="muted">not used</span>'}</td>
      </tr>`)
      .join('');
    return `
      <section>
        <h2>Attributes</h2>
        <p class="hint">Policies restrict access with attributes (<code>WHERE Region = 'EU'</code>). CAP maps each one to a CDS element with <code>@ams.attributes</code>. ${state.schemaFile ? `They are declared in ${link(state.schemaFile, 1, state.schemaFile)}.` : state.generates.schema ? '"cds build" generates schema.dcl from the mappings.' : 'There is no schema.dcl.'}</p>
        ${rows ? `<table><thead><tr><th>Attribute</th><th>Type</th><th>CDS element</th><th>Used in policies</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No attributes.</p>'}
      </section>`;
  }

  function checksView() {
    const body = findings.length
      ? findings
          .map((f) => `<div class="finding ${esc(f.severity)}">
            <div><b>${f.severity === 'error' ? '✖' : f.severity === 'warning' ? '▲' : '●'} ${esc(f.title)}</b> <span class="muted">${esc(f.ruleId)} · ${link(f.file, f.line)}</span></div>
            <div>${esc(f.message)}</div>
            ${f.fix ? `<div class="muted">Fix: ${esc(f.fix)}</div>` : ''}
            ${f.fixes.length ? `<div class="row">${f.fixes.map((t, j) => btn(f.auto[j] ? t : `${t} (review)`, { type: 'applyFix', i: f.i, fix: j }, f.auto[j] ? '' : 'secondary')).join('')}</div>` : ''}
          </div>`)
          .join('')
      : '<p class="ok">No problems with roles, policies or login.</p>';
    return `
      <section>
        <h2>Checks</h2>
        <p class="hint">Deploy Doctor checks for AMS policies, the CDS model, the identity binding and login. They run again whenever you save a file in the project.</p>
        ${body}
      </section>`;
  }

  function tokenView() {
    const r = report;
    let out = '';
    if (r && !r.ok) out = `<div class="banner bad">${esc(r.error)}</div>`;
    if (r && r.ok) {
      const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');
      const known = r.roles.some((x) => x.inToken !== undefined);
      out = `
        ${r.notes.length ? `<ul class="issues">${r.notes.map((n) => `<li class="warning">▲ ${esc(n)}</li>`).join('')}</ul>` : ''}
        <table class="form">
          ${row('Kind', esc(r.kind === 'ias' ? 'Identity Authentication (IAS)' : r.kind === 'xsuaa' ? 'XSUAA' : 'unknown'))}
          ${row('User', esc(r.subject))}
          ${row('SCIM ID', esc(r.scimId))}
          ${row('Tenant (app_tid)', esc(r.tenant))}
          ${row('Client', esc(r.clientId))}
          ${row('Audience', esc((r.audience || []).join(', ')))}
          ${row('Expires', r.expires ? `${esc(r.expires)}${r.expired ? ' <span class="bad">expired</span>' : ''}` : '')}
          ${row('Issuer', esc(r.issuer))}
          ${row('Groups', esc(r.groups.join(', ')))}
        </table>
        ${r.apis.length ? `<h2>API permission groups (ias_apis)</h2><table><thead><tr><th>Group</th><th>Internal policy</th><th>Roles</th></tr></thead><tbody>${r.apis.map((a) => `<tr><td>${esc(a.name)}</td><td>${a.policy ? policyLink(a.policy) : no}</td><td>${esc(a.roles.join(', '))}</td></tr>`).join('')}</tbody></table>` : ''}
        ${r.roles.length ? `<h2>CDS roles</h2><table><thead><tr><th>Role</th>${known ? '<th>In token</th>' : ''}<th>Assign one of these policies to get it</th></tr></thead><tbody>${r.roles.map((x) => `<tr><td>${esc(x.role)}</td>${known ? `<td>${x.inToken ? '<span class="ok">✓</span>' : no}</td>` : ''}<td>${x.policies.length ? x.policies.map(policyLink).join(', ') : `${no} <span class="bad">none</span>`}</td></tr>`).join('')}</tbody></table>` : ''}`;
    }
    return `
      <section>
        <h2>Explain a token</h2>
        <p class="hint">Paste a JWT, for example from the Authorization header of a request that fails with 401 or 403. It is decoded on your machine and never saved or sent anywhere. The signature is not verified.</p>
        <textarea id="token" rows="5" spellcheck="false" autocomplete="off" placeholder="eyJhbGciOi..."></textarea>
        <p class="row"><button data-token="explain">Explain</button> <button class="secondary" data-token="clear">Clear result</button></p>
        ${out}
      </section>`;
  }

  send({ type: 'ready' });
})();

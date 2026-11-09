// Auth Studio webview. Renders state from the extension host; every change goes back as a message.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let tab = saved.tab || 'roles';
  let state;
  let checks;
  let report;

  const P = '$XSAPPNAME.';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const local = (s) => (s.startsWith(P) ? s.slice(P.length) : s);
  const attr = (o) => esc(JSON.stringify(o));
  const send = (msg) => vscode.postMessage(msg);
  const yes = '<span class="ok" title="yes">✓</span>';
  const no = '<span class="bad" title="no">✗</span>';
  const link = (file, line) => `<a href="#" data-open="${attr({ file, line })}">${esc(file)}:${esc(line)}</a>`;
  const btn = (label, msg, cls = '') => `<button class="${cls}" data-msg="${attr(msg)}">${esc(label)}</button>`;
  const remove = (what, name, edit, detail) =>
    `<button class="icon" title="Remove ${esc(what)} ${esc(name)}" aria-label="Remove ${esc(what)} ${esc(name)}" data-msg="${attr({ type: 'remove', question: `Remove ${what} "${name}"?`, detail, edit })}">×</button>`;
  const describe = (list, item) =>
    `<button class="icon" title="Edit description" aria-label="Edit description of ${esc(item.name)}" data-msg="${attr({ type: 'prompt', prompt: 'describe', arg: { list, name: item.name, description: item.description } })}">✎</button>`;

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') state = m.state;
    if (m.type === 'checks') checks = m.findings;
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
      render();
      return;
    }
    send(JSON.parse(el.dataset.msg));
  });

  app.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.toggle) send({ type: 'edit', edit: { ...JSON.parse(el.dataset.toggle), on: el.checked } });
    if (el.id === 'tenant-mode') send({ type: 'edit', edit: { kind: 'setTenantMode', value: el.value } });
  });

  // ---------------- views ----------------

  function render() {
    if (!state) return;
    const d = state.descriptor;
    const errors = state.issues.filter((i) => i.severity === 'error').length;
    const warnings = state.issues.length - errors;
    const tabs = [
      ['roles', 'Roles'],
      ['collections', 'Role collections'],
      ['attributes', 'Attributes'],
      ['settings', 'Settings'],
      ['checks', `Checks${errors + warnings ? ` (${errors + warnings})` : ''}`],
      ['token', 'Token'],
    ];
    const keepToken = document.getElementById('token')?.value || '';
    app.innerHTML = `
      <header>
        <div>
          <h1>Auth Studio</h1>
          <div class="muted">${esc(state.file)}${state.dirty ? ' · unsaved' : ''}</div>
        </div>
        <div class="actions">
          ${errors ? `<span class="badge bad">${errors} error${errors > 1 ? 's' : ''}</span>` : ''}
          ${warnings ? `<span class="badge warn">${warnings} warning${warnings > 1 ? 's' : ''}</span>` : ''}
          ${!errors && !warnings && !d.error ? '<span class="badge ok">No problems</span>' : ''}
          ${btn('Open as JSON', { type: 'openJson' }, 'secondary')}
        </div>
      </header>
      ${d.error ? `<div class="banner bad">This file is not valid JSON (${esc(d.error)}). Fix it in the JSON editor, then come back.</div>` : ''}
      ${overrideBanner()}
      <nav role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'active' : ''}" data-tab="${id}">${esc(label)}</button>`).join('')}</nav>
      <main>${d.error && tab !== 'token' ? '' : view()}</main>`;
    const t = document.getElementById('token');
    if (t) t.value = keepToken;
  }

  function view() {
    switch (tab) {
      case 'collections': return collectionsView();
      case 'attributes': return attributesView();
      case 'settings': return settingsView();
      case 'checks': return checksView();
      case 'token': return tokenView();
      default: return rolesView();
    }
  }

  function overrideBanner() {
    const b = state.binding;
    if (!b || !b.overrides.length) return '';
    const shown = b.overrides.map((k) => {
      const v = b.values[k];
      return typeof v === 'string' ? `<code>${esc(k)}: ${esc(v)}</code>` : `<code>${esc(k)}</code>`;
    });
    return `<div class="banner">At deploy, ${esc(b.mtaFile)} (resource <b>${esc(b.resource)}</b>) adds ${shown.join(', ')} on top of this file. Those values win.</div>`;
  }

  function rolesView() {
    const d = state.descriptor;
    const missing = state.roles.filter((r) => !r.scope || !r.templates.length).length + state.attributes.filter((a) => !a.defined).length;
    const cds = state.roles.length
      ? `<table>
          <thead><tr><th>CDS role</th><th>Used in</th><th>Scope</th><th>Role templates</th><th>Role collections</th><th></th></tr></thead>
          <tbody>${state.roles
            .map((r) => `<tr>
              <td><b>${esc(r.role)}</b></td>
              <td>${link(r.file, r.line)}</td>
              <td>${r.scope ? yes : no}</td>
              <td>${r.templates.length ? esc(r.templates.join(', ')) : no}</td>
              <td>${r.collections.length ? esc(r.collections.join(', ')) : '<span class="muted">none</span>'}</td>
              <td>${!r.scope ? btn('Add role', { type: 'edit', edit: { kind: 'addRole', name: r.role } }) : !r.templates.length ? btn('Add role template', { type: 'edit', edit: { kind: 'addRole', name: r.role } }) : ''}</td>
            </tr>`)
            .join('')}</tbody>
        </table>
        ${missing > 1 ? `<p>${btn(`Add all ${missing} missing`, { type: 'addMissing' })}</p>` : ''}`
      : `<p class="muted">No roles found in @requires or @restrict annotations (${esc(state.cdsFiles)} .cds files scanned).</p>`;

    const scopes = d.scopes;
    const matrix = d.templates.length || scopes.length
      ? `<div class="scroll"><table class="matrix">
          <thead><tr><th>Role template</th>${scopes
            .map((s) => `<th title="${esc(s.description)}">${esc(local(s.name))}${s.technical ? ' <span class="tag">technical</span>' : ''} ${remove('scope', s.name, { kind: 'removeScope', name: s.name }, 'It is also removed from every role template that references it.')}</th>`)
            .join('')}<th>Other references</th></tr></thead>
          <tbody>${d.templates
            .map((t) => `<tr>
              <th scope="row"><span title="${esc(t.description)}">${esc(t.name)}</span> ${describe('role-templates', t)} ${remove('role template', t.name, { kind: 'removeTemplate', name: t.name }, 'It is also removed from every role collection that references it.')}</th>
              ${scopes.map((s) => `<td class="c"><input type="checkbox" aria-label="${esc(t.name)} grants ${esc(local(s.name))}" ${t.scopes.includes(s.name) ? 'checked' : ''} data-toggle="${attr({ kind: 'toggleTemplateScope', template: t.name, scope: s.name })}"></td>`).join('')}
              <td>${t.scopes
                .filter((x) => !scopes.some((s) => s.name === x))
                .map((x) => (x.startsWith(P)
                  ? `<span class="ref bad" title="No scope with this name: XSUAA rejects the file">${esc(x)} ${remove('reference', x, { kind: 'toggleTemplateScope', template: t.name, scope: x, on: false })}</span>`
                  : `<span class="ref muted">${esc(x)}</span>`))
                .join(' ')}</td>
            </tr>`)
            .join('')}</tbody>
        </table></div>`
      : '<p class="muted">No scopes or role templates yet.</p>';

    return `
      <section>
        <h2>Roles in your CDS model</h2>
        <p class="hint">CAP checks these role names. Each one needs a scope <code>$XSAPPNAME.&lt;role&gt;</code> and a role template that grants it, or users get 403 Forbidden.</p>
        ${cds}
      </section>
      <section>
        <h2>Role templates and scopes</h2>
        <p class="hint">Tick the scopes each role template grants. Users get role templates through role collections.</p>
        ${matrix}
        <p class="row">
          ${btn('+ Role (scope and template)', { type: 'prompt', prompt: 'addRole' })}
          ${btn('+ Scope', { type: 'prompt', prompt: 'addScope' }, 'secondary')}
          ${btn('+ Role template', { type: 'prompt', prompt: 'addTemplate' }, 'secondary')}
        </p>
      </section>`;
  }

  function collectionsView() {
    const d = state.descriptor;
    const b = state.binding;
    const fromMta = b && b.overrides.includes('role-collections');
    const mtaList = fromMta && Array.isArray(b.values['role-collections']) ? b.values['role-collections'] : [];
    const names = new Set(d.templates.map((t) => t.name));
    const unknown = d.collections.some((c) => c.templates.some((x) => !names.has(x)));
    const table = d.collections.length && d.templates.length
      ? `<div class="scroll"><table class="matrix">
          <thead><tr><th>Role collection</th>${d.templates.map((t) => `<th>${esc(t.name)}</th>`).join('')}${unknown ? '<th>Unknown references</th>' : ''}</tr></thead>
          <tbody>${d.collections
            .map((c) => `<tr>
              <th scope="row"><span title="${esc(c.description)}">${esc(c.name)}</span> ${describe('role-collections', c)} ${remove('role collection', c.name, { kind: 'removeCollection', name: c.name })}</th>
              ${d.templates.map((t) => `<td class="c"><input type="checkbox" aria-label="${esc(c.name)} contains ${esc(t.name)}" ${c.templates.includes(t.name) ? 'checked' : ''} data-toggle="${attr({ kind: 'toggleCollectionTemplate', collection: c.name, template: t.name })}"></td>`).join('')}
              ${unknown ? `<td>${c.templates.filter((x) => !names.has(x)).map((x) => `<span class="ref bad" title="No role template with this name: XSUAA rejects the file">${esc(x)} ${remove('reference', x, { kind: 'toggleCollectionTemplate', collection: c.name, template: x, on: false })}</span>`).join(' ')}</td>` : ''}
            </tr>`)
            .join('')}</tbody>
        </table></div>`
      : d.collections.length
        ? `<p class="muted">${esc(d.collections.map((c) => c.name).join(', '))}. Add role templates to assign them.</p>`
        : '<p class="muted">No role collections in this file.</p>';
    return `
      <section>
        <h2>Role collections</h2>
        <p class="hint">Role collections defined here are created when you deploy. Assign them to users in the BTP cockpit (Security &gt; Users), or through your identity provider's groups.</p>
        ${fromMta ? `<div class="banner">${esc(b.mtaFile)} defines the role collections at deploy, so the ones below from this file are replaced: ${mtaList.length ? mtaList.map((c) => `<b>${esc(c && c.name)}</b> (${esc((c && c['role-template-references'] || []).map(local).join(', '))})`).join('; ') : 'none'}.</div>` : ''}
        ${table}
        <p class="row">${btn('+ Role collection', { type: 'prompt', prompt: 'addCollection' })}</p>
      </section>`;
  }

  function attributesView() {
    const d = state.descriptor;
    const cds = state.attributes.length
      ? `<table>
          <thead><tr><th>$user attribute</th><th>Used in</th><th>Defined</th><th>Role templates</th><th></th></tr></thead>
          <tbody>${state.attributes
            .map((a) => `<tr>
              <td><b>${esc(a.name)}</b></td><td>${link(a.file, a.line)}</td><td>${a.defined ? yes : no}</td>
              <td>${a.templates.length ? esc(a.templates.join(', ')) : '<span class="muted">none</span>'}</td>
              <td>${a.defined ? '' : btn('Add attribute', { type: 'edit', edit: { kind: 'addAttribute', name: a.name } })}</td>
            </tr>`)
            .join('')}</tbody>
        </table>`
      : '<p class="muted">No $user attributes in @restrict where conditions.</p>';
    const matrix = d.attributes.length && d.templates.length
      ? `<div class="scroll"><table class="matrix">
          <thead><tr><th>Role template</th>${d.attributes.map((a) => `<th title="${esc(a.description)}">${esc(a.name)} ${remove('attribute', a.name, { kind: 'removeAttribute', name: a.name }, 'It is also removed from every role template that references it.')}</th>`).join('')}</tr></thead>
          <tbody>${d.templates
            .map((t) => `<tr><th scope="row">${esc(t.name)}</th>${d.attributes
              .map((a) => `<td class="c"><input type="checkbox" aria-label="${esc(t.name)} uses ${esc(a.name)}" ${t.attributes.includes(a.name) ? 'checked' : ''} data-toggle="${attr({ kind: 'toggleTemplateAttribute', template: t.name, attribute: a.name })}"></td>`)
              .join('')}</tr>`)
            .join('')}</tbody>
        </table></div>`
      : d.attributes.length
        ? `<p class="muted">${esc(d.attributes.map((a) => a.name).join(', '))}</p>`
        : '<p class="muted">No attributes defined.</p>';
    return `
      <section>
        <h2>Attributes used in your CDS model</h2>
        <p class="hint">A @restrict condition such as <code>country = $user.country</code> only works if the attribute exists and the user's role template passes it on. Otherwise the user sees no rows.</p>
        ${cds}
      </section>
      <section>
        <h2>Attributes per role template</h2>
        ${matrix}
        <p class="row">${btn('+ Attribute', { type: 'prompt', prompt: 'addAttribute' })}</p>
      </section>`;
  }

  function settingsView() {
    const d = state.descriptor;
    const b = state.binding;
    const over = (k) => (b && b.overrides.includes(k) ? ` <span class="tag">mta.yaml: ${esc(typeof b.values[k] === 'string' ? b.values[k] : 'set')}</span>` : '');
    const modes = ['dedicated', 'shared', 'external'];
    return `
      <section>
        <h2>Application</h2>
        <table class="form">
          <tr><th>xsappname</th><td><code>${esc(d.xsappname || '(missing)')}</code>${over('xsappname')} ${btn('Change', { type: 'prompt', prompt: 'setXsappname' }, 'secondary small')}</td></tr>
          <tr><th><label for="tenant-mode">Tenant mode</label></th><td><select id="tenant-mode">${modes.map((m) => `<option ${d.tenantMode === m ? 'selected' : ''}>${m}</option>`).join('')}${d.tenantMode && !modes.includes(d.tenantMode) ? `<option selected>${esc(d.tenantMode)}</option>` : ''}${!d.tenantMode ? '<option selected value="">(not set: dedicated)</option>' : ''}</select>${over('tenant-mode')}
            <div class="hint">Use "shared" for multitenant (SaaS) apps, "dedicated" otherwise.</div></td></tr>
          <tr><th>Bound to</th><td>${b ? `${esc(b.boundTo.join(', ') || 'no module')} <span class="muted">(service instance "${esc(b.instance)}")</span>` : '<span class="muted">No XSUAA resource in mta.yaml uses this file.</span>'}</td></tr>
        </table>
      </section>
      <section>
        <h2>Allowed redirect URIs</h2>
        <p class="hint">After login, XSUAA only sends users back to these URLs. Add a pattern that covers your approuter, for example <code>https://*.cfapps.eu10.hana.ondemand.com/**</code>.</p>
        ${d.redirectUris.length ? `<ul class="plain">${d.redirectUris.map((u, i) => `<li><code>${esc(u)}</code> ${remove('redirect URI', u, { kind: 'setRedirectUris', value: d.redirectUris.filter((_, j) => j !== i) })}</li>`).join('')}</ul>` : '<p class="muted">None set: XSUAA accepts any redirect URL in your landscape.</p>'}
        <p class="row">${btn('+ Redirect URI', { type: 'prompt', prompt: 'addRedirectUri' }, 'secondary')}</p>
      </section>
      <section>
        <h2>Update the running XSUAA instance</h2>
        <p class="hint">Changes in this file reach XSUAA only when you redeploy or update the service instance.</p>
        <p class="row">${btn('Prepare cf update-service', { type: 'push' }, 'secondary')}</p>
        <p class="hint">Opens a terminal with the command, without running it. Check the target space first.</p>
      </section>`;
  }

  function checksView() {
    const live = state.issues.length
      ? `<ul class="issues">${state.issues.map((i) => `<li class="${i.severity}">${i.severity === 'error' ? '✖' : '▲'} ${esc(i.message)}</li>`).join('')}</ul>`
      : '<p class="ok">No problems in this file.</p>';
    const ran = checks === undefined
      ? '<p class="muted">Not run yet.</p>'
      : checks.length
        ? checks
            .map((f) => `<div class="finding ${esc(f.severity)}">
              <div><b>${f.severity === 'error' ? '✖' : f.severity === 'warning' ? '▲' : '●'} ${esc(f.title)}</b> <span class="muted">${esc(f.ruleId)} · ${link(f.file, f.line)}</span></div>
              <div>${esc(f.message)}</div>
              ${f.fix ? `<div class="muted">Fix: ${esc(f.fix)}</div>` : ''}
              ${f.fixes.length ? `<div class="row">${f.fixes.map((t, j) => btn(t, { type: 'applyFix', i: f.i, fix: j })).join('')}</div>` : ''}
            </div>`)
            .join('')
        : '<p class="ok">No authorization problems in the project.</p>';
    return `
      <section>
        <h2>This file</h2>
        <p class="hint">Checked as you edit.</p>
        ${live}
      </section>
      <section>
        <h2>Project</h2>
        <p class="hint">Runs the Deploy Doctor checks for roles and login across mta.yaml, the CDS model and this file. Saves this file first.</p>
        <p class="row">${btn(checks === undefined ? 'Run checks' : 'Run again', { type: 'runChecks' })}</p>
        ${ran}
      </section>`;
  }

  function tokenView() {
    const r = report;
    let out = '';
    if (r && !r.ok) out = `<div class="banner bad">${esc(r.error)}</div>`;
    if (r && r.ok) {
      const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '');
      out = `
        ${r.notes.length ? `<ul class="issues">${r.notes.map((n) => `<li class="warning">▲ ${esc(n)}</li>`).join('')}</ul>` : '<p class="ok">This token grants every role your CDS model uses.</p>'}
        <table class="form">
          ${row('User', esc(r.subject))}
          ${row('Client', esc(r.clientId))}
          ${row('Grant type', esc(r.grantType))}
          ${row('Expires', r.expires ? `${esc(r.expires)}${r.expired ? ' <span class="bad">expired</span>' : ''}` : '')}
          ${row('Issuer', esc(r.issuer))}
          ${row('Role collections', esc(r.roleCollections.join(', ')))}
          ${row('Attributes', esc(Object.entries(r.attributes).map(([k, v]) => `${k} = ${v.join(', ')}`).join('; ')))}
        </table>
        ${r.roles.length ? `<h2>CDS roles</h2><table><thead><tr><th>Role</th><th>Granted</th><th>Scope in token</th></tr></thead><tbody>${r.roles.map((x) => `<tr><td>${esc(x.role)}</td><td>${x.granted ? yes : no}</td><td>${esc(x.via || '')}</td></tr>`).join('')}</tbody></table>` : ''}
        <h2>Scopes</h2>
        ${r.apps.map((a) => `<p><b>${esc(a.app)}</b>: ${esc(a.scopes.join(', '))}</p>`).join('')}
        ${r.otherScopes.length ? `<p class="muted">Other: ${esc(r.otherScopes.join(', '))}</p>` : ''}`;
    }
    return `
      <section>
        <h2>Explain a token</h2>
        <p class="hint">Paste a JWT, for example from the Authorization header of a failing request, to see which CDS roles it grants. It is decoded on your machine and never saved or sent anywhere. The signature is not verified.</p>
        <textarea id="token" rows="5" spellcheck="false" autocomplete="off" placeholder="eyJhbGciOi..."></textarea>
        <p class="row"><button data-token="explain">Explain</button> <button class="secondary" data-token="clear">Clear result</button></p>
        ${out}
      </section>`;
  }

  send({ type: 'ready' });
})();

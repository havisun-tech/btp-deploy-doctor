// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  /** @type {any} */
  const state = { apps: [], target: {}, selected: '', report: null, busy: '', error: null, calls: {}, pending: {}, open: {}, paths: {} };
  const send = (m) => vscode.postMessage(m);
  window.addEventListener('error', (e) => send({ type: 'log', message: `${e.message} (${e.lineno}:${e.colno})` }));
  window.addEventListener('unhandledrejection', (e) => send({ type: 'log', message: String(e.reason) }));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ICON = { ok: '✔', info: 'ℹ', warning: '▲', error: '✖', skipped: '○' };
  const LABEL = { ok: 'OK', info: 'Info', warning: 'Warning', error: 'Error', skipped: 'Not tested' };
  const icon = (s) => `<span class="st ${s}" title="${LABEL[s]}" aria-label="${LABEL[s]}">${ICON[s]}</span>`;

  function check(c) {
    return `<li class="check ${c.status}">${icon(c.status)}<div><div class="t">${esc(c.title)}</div>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}${c.fix ? `<div class="fix"><b>Fix:</b> ${esc(c.fix)}</div>` : ''}</div></li>`;
  }

  function header() {
    const t = state.target || {};
    const where = t.org ? `${esc(t.org)} / ${esc(t.space)}${t.user ? ` · ${esc(t.user)}` : ''}` : 'No Cloud Foundry target';
    const opts = state.apps.map((a) => `<option value="${esc(a.name)}" ${a.name === state.selected ? 'selected' : ''}>${esc(a.name)}${a.state && a.state !== 'STARTED' ? ` (${esc(a.state.toLowerCase())})` : ''}</option>`).join('');
    return `<header>
      <div><h1>Connectivity Doctor</h1><div class="muted">${where}</div></div>
      <div class="actions">
        ${state.apps.length ? `<label for="app-select" class="muted">App</label><select id="app-select">${opts}</select><button id="run" ${state.busy ? 'disabled' : ''}>Check destinations</button>` : ''}
        <button class="secondary" id="reload" title="Read the apps again, for example after cf login or cf target">Reload apps</button>
      </div>
    </header>`;
  }

  function destination(d) {
    const tags = [d.proxyType, d.authentication, d.level && `${d.level} level`].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ');
    const open = state.open[d.name] ?? d.status !== 'ok';
    const call = state.calls[d.name];
    const pend = state.pending[d.name];
    let actions = '';
    const tokenFailed = d.checks.some((c) => c.id === 'token' && c.status === 'error');
    if (d.callable && !tokenFailed) {
      actions += `<div class="row action">
        <label for="path-${esc(d.name)}" class="muted">Test call</label>
        <input id="path-${esc(d.name)}" data-path="${esc(d.name)}" placeholder="optional path, e.g. /sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata" value="${esc(state.paths[d.name] ?? '')}">
        <button class="secondary" data-call="${esc(d.name)}" ${pend ? 'disabled' : ''}>${pend === 'call' ? 'Calling…' : 'Call from here'}</button>
      </div>
      <p class="hint">Sends a GET request from this machine with the credentials the Destination service returns, like the app would.${d.userDependent ? ' Paste a user token below first.' : ''}</p>`;
    }
    if (d.userDependent && d.authentication !== 'PrincipalPropagation' && d.level) {
      actions += `<details class="token"><summary>Test the token exchange with a user token</summary>
        <p class="hint">Paste the JWT of a logged-in user, issued by XSUAA or IAS of this subaccount, for example from the Authorization header your app receives. It stays in memory and is only sent to the Destination service.</p>
        <textarea rows="3" data-token="${esc(d.name)}" placeholder="eyJ…"></textarea>
        <div class="row"><button class="secondary" data-usetoken="${esc(d.name)}" ${pend ? 'disabled' : ''}>${pend === 'token' ? 'Checking…' : 'Test exchange'}</button></div>
      </details>`;
    }
    const cfg = d.config
      ? `<details class="cfg"><summary>Configuration</summary><table>${Object.entries(d.config).filter(([, v]) => v !== '').map(([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(v)}</code></td></tr>`).join('')}</table></details>`
      : '';
    return `<details class="dest ${d.status}" data-dest="${esc(d.name)}" ${open ? 'open' : ''}>
      <summary>${icon(d.status)}<span class="name">${esc(d.name)}</span> ${tags}${d.usedBy.length ? ` <span class="muted">used by ${d.usedBy.map(esc).join(', ')}</span>` : ''}</summary>
      ${d.url ? `<div class="url muted">${esc(d.url)}</div>` : ''}
      <ul class="checks">${d.checks.filter((c) => c.id !== 'used').map(check).join('')}${call ? check(call) : ''}</ul>
      ${actions}${cfg}
    </details>`;
  }

  function report(r) {
    const n = (s) => r.destinations.filter((d) => d.status === s).length;
    const sum = r.destinations.length
      ? `<p class="summary">${r.destinations.length} destination${r.destinations.length === 1 ? '' : 's'}: <span class="st error">${n('error')} with errors</span> · <span class="st warning">${n('warning')} with warnings</span> · ${n('skipped') ? `<span class="st skipped">${n('skipped')} not fully tested</span> · ` : ''}<span class="st ok">${r.destinations.length - n('error') - n('warning') - n('skipped')} OK</span></p>`
      : '';
    return `<h2>App "${esc(r.app)}"</h2>
      <ul class="checks">${r.checks.map(check).join('')}</ul>
      ${sum}
      ${r.destinations.map(destination).join('')}
      <div class="row footer"><button class="secondary" id="copy">Copy report as text</button><span class="muted">Checked ${esc(new Date(r.checkedAt).toLocaleTimeString())}</span></div>`;
  }

  function render() {
    // keep typed paths when re-rendering
    document.querySelectorAll('input[data-path]').forEach((el) => (state.paths[/** @type {any} */ (el).dataset.path] = /** @type {HTMLInputElement} */ (el).value));
    let body = '';
    if (state.error) {
      body += `<div class="banner bad"><b>${esc(state.error.message)}</b>${
        state.error.cf
          ? `<p>Connectivity Doctor reads the app's service bindings with your Cloud Foundry login. Run <code>cf login</code> in a terminal (in SAP Business Application Studio you can also use <b>CF: Login to Cloud Foundry</b>), then reload.</p><div class="row"><button class="secondary" id="terminal">Open terminal</button><button class="secondary" id="settings">Set cf path</button></div>`
          : ''
      }</div>`;
    }
    if (state.busy) body += `<p class="busy"><span class="spinner"></span>${esc(state.busy)}</p>`;
    else if (state.report) body += report(state.report);
    else if (state.apps.length) body += `<p class="hint">Pick the app that calls other systems (usually the CAP service) and click <b>Check destinations</b>.</p>`;
    else if (!state.error) body += `<p class="hint">No apps in this space.</p>`;
    body += `<p class="privacy muted">Uses your cf login to read the app's bindings. Credentials and tokens stay in memory and are never stored or shown. Systems are only called when you click <b>Call from here</b>.${state.version ? ` · v${esc(state.version)}` : ''}</p>`;
    app.innerHTML = header() + body;
  }

  app.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    const b = el.closest('button');
    if (!b) return;
    if (b.id === 'run') {
      state.selected = /** @type {HTMLSelectElement} */ (document.getElementById('app-select')).value;
      state.calls = {};
      send({ type: 'run', app: state.selected });
    } else if (b.id === 'reload') send({ type: 'loadApps' });
    else if (b.id === 'copy') send({ type: 'copy' });
    else if (b.id === 'terminal') send({ type: 'terminal' });
    else if (b.id === 'settings') send({ type: 'settings' });
    else if (b.dataset.call) {
      const name = b.dataset.call;
      const input = /** @type {HTMLInputElement | null} */ (document.querySelector(`input[data-path="${CSS.escape(name)}"]`));
      const tok = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(`textarea[data-token="${CSS.escape(name)}"]`));
      send({ type: 'testCall', name, path: input?.value ?? '', userToken: tok?.value || undefined });
    } else if (b.dataset.usetoken) {
      const name = b.dataset.usetoken;
      const tok = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(`textarea[data-token="${CSS.escape(name)}"]`));
      send({ type: 'userToken', name, token: tok?.value ?? '' });
    }
  });
  app.addEventListener('toggle', (e) => {
    const d = /** @type {HTMLDetailsElement} */ (e.target);
    if (d.dataset?.dest) state.open[d.dataset.dest] = d.open;
  }, true);
  app.addEventListener('change', (e) => {
    const el = /** @type {HTMLSelectElement} */ (e.target);
    if (el.id === 'app-select') state.selected = el.value;
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'busy') Object.assign(state, { busy: m.text, error: null });
    else if (m.type === 'apps') Object.assign(state, { apps: m.apps, target: m.target, selected: m.suggested ?? '', busy: '', error: null, version: m.version });
    else if (m.type === 'report') {
      Object.assign(state, { report: m.report, busy: '', error: null, pending: {} });
    } else if (m.type === 'error') Object.assign(state, { error: m, busy: '', pending: {}, target: m.target ?? state.target });
    else if (m.type === 'pending') state.pending[m.name] = m.what;
    else if (m.type === 'call') {
      state.calls[m.name] = m.check;
      delete state.pending[m.name];
    }
    render();
  });

  render();
  send({ type: 'ready' });
})();

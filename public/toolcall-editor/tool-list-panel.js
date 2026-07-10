/* ToolCall 复合组件 — 画布侧栏工具列表编辑器（ADR-003） */
(function () {
  const META = new Set(['skill_search', 'skill_activate']);

  /** @type {{ tools: object[]; skills: object[]; meta_tools: object[] } | null} */
  let catalog = null;

  async function loadCatalog() {
    if (catalog) return catalog;
    const res = await fetch('/toolcall-editor/catalog.json');
    catalog = await res.json();
    return catalog;
  }

  function parseList(raw) {
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) return raw;
    try {
      const p = JSON.parse(String(raw));
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }

  function serializeList(tools) {
    return JSON.stringify(tools, null, 2);
  }

  function normalize(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const name = String(entry.name ?? entry.function?.name ?? '').trim();
    if (!name) return null;
    return {
      name,
      desc: entry.desc ?? entry.description ?? entry.function?.description ?? name,
    };
  }

  function setInputValue(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findHiddenInput(host) {
    const row = host.closest('.polar-tool-list-row') ?? host.closest('.param-row');
    return row?.querySelector('input[data-tool-list-sync]') ?? null;
  }

  function mountEditor(host) {
    if (host.dataset.mounted === '1') return;
    host.dataset.mounted = '1';

    const hidden = findHiddenInput(host);
    if (!hidden) return;

    let tools = parseList(hidden.value).map(normalize).filter(Boolean);

    const wrap = document.createElement('div');
    wrap.className = 'ptl-wrap';

    const metaBar = document.createElement('div');
    metaBar.className = 'ptl-meta';
    metaBar.innerHTML = '<span class="ptl-meta-label">元工具（运行时自动注入）</span>'
      + '<span class="ptl-chip">skill_search</span><span class="ptl-chip">skill_activate</span>';
    wrap.appendChild(metaBar);

    const listEl = document.createElement('ul');
    listEl.className = 'ptl-list';
    wrap.appendChild(listEl);

    const addRow = document.createElement('div');
    addRow.className = 'ptl-add';
    const select = document.createElement('select');
    select.className = 'ptl-select';
    select.innerHTML = '<option value="">+ 添加工具…</option>';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ptl-btn';
    addBtn.textContent = '添加';
    addRow.append(select, addBtn);
    wrap.appendChild(addRow);

    const skillSec = document.createElement('details');
    skillSec.className = 'ptl-skills';
    skillSec.innerHTML = '<summary>加载 Skill 工具</summary>';
    const skillSearch = document.createElement('input');
    skillSearch.type = 'search';
    skillSearch.className = 'ptl-search';
    skillSearch.placeholder = '搜索 skill…';
    const skillResults = document.createElement('div');
    skillResults.className = 'ptl-skill-results';
    skillSec.append(skillSearch, skillResults);
    wrap.appendChild(skillSec);

    host.appendChild(wrap);

    function commit() {
      setInputValue(hidden, serializeList(tools));
      renderList();
    }

    function renderList() {
      listEl.innerHTML = '';
      if (!tools.length) {
        listEl.innerHTML = '<li class="ptl-empty">（空列表 — 请添加 FileRead / WebSearch 等）</li>';
        return;
      }
      for (const t of tools) {
        const li = document.createElement('li');
        li.className = 'ptl-item';
        li.innerHTML = `<span class="ptl-name">${t.name}</span>`
          + `<span class="ptl-desc">${(t.desc ?? '').slice(0, 60)}</span>`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ptl-btn ptl-btn--danger';
        rm.textContent = '×';
        rm.title = '移除';
        rm.onclick = () => {
          tools = tools.filter((x) => x.name !== t.name);
          commit();
        };
        li.appendChild(rm);
        listEl.appendChild(li);
      }
    }

    function fillSelect() {
      const cat = catalog;
      if (!cat) return;
      const existing = new Set(tools.map((t) => t.name));
      for (const t of cat.tools ?? []) {
        if (existing.has(t.name) || META.has(t.name)) continue;
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = `${t.name} — ${(t.display_name ?? t.name).slice(0, 24)}`;
        select.appendChild(opt);
      }
    }

    addBtn.onclick = () => {
      const name = select.value;
      if (!name) return;
      const def = (catalog?.tools ?? []).find((t) => t.name === name);
      tools = [...tools, { name, desc: def?.description ?? name }];
      select.value = '';
      commit();
    };

    function renderSkillResults(q) {
      skillResults.innerHTML = '';
      const query = (q ?? '').trim().toLowerCase();
      const hits = (catalog?.skills ?? []).filter((s) => {
        if (!query) return true;
        return s.name.toLowerCase().includes(query)
          || (s.description ?? '').toLowerCase().includes(query);
      }).slice(0, 12);

      for (const s of hits) {
        const row = document.createElement('div');
        row.className = 'ptl-skill-row';
        row.innerHTML = `<strong>${s.name}</strong><span>${(s.description ?? '').slice(0, 80)}</span>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ptl-btn';
        btn.textContent = '加载';
        btn.onclick = () => {
          const names = s.toolNames?.length ? s.toolNames : [s.name];
          for (const n of names) {
            if (!tools.some((t) => t.name === n)) {
              tools.push({ name: n, desc: `[${s.name}] ${n}` });
            }
          }
          commit();
        };
        row.appendChild(btn);
        skillResults.appendChild(row);
      }
      if (!hits.length) skillResults.textContent = '无匹配 skill';
    }

    skillSearch.oninput = () => renderSkillResults(skillSearch.value);

    loadCatalog().then(() => {
      fillSelect();
      renderSkillResults('');
      renderList();
    });

    hidden.addEventListener('input', () => {
      tools = parseList(hidden.value).map(normalize).filter(Boolean);
      renderList();
    });
  }

  function scan() {
    document.querySelectorAll('.polar-tool-list-host:not([data-mounted="1"])').forEach(mountEditor);
  }

  const obs = new MutationObserver(() => scan());
  obs.observe(document.body, { childList: true, subtree: true });
  scan();
})();

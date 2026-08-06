let configurations = [];
let scriptEditor = null;
let confirmActionCallback = null;
let activeCategory = '';

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vulndb-theme', theme);
    document.getElementById('icon-sun')?.classList.toggle('hidden', theme !== 'dark');
    document.getElementById('icon-moon')?.classList.toggle('hidden', theme === 'dark');
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

function showConfirmModal(title, message, onConfirm) {
    document.getElementById('confirm-modal-title').innerText = title;
    document.getElementById('confirm-modal-message').innerText = message;

    document.getElementById('confirm-modal').classList.remove('hidden');
    setTimeout(() => {
        document.querySelector('#confirm-modal .card').classList.add('modal-enter-active');
    }, 10);

    confirmActionCallback = onConfirm;
}

function closeConfirmModal() {
    const modalContent = document.querySelector('#confirm-modal .card');
    if (modalContent) modalContent.classList.remove('modal-enter-active');
    setTimeout(() => {
        document.getElementById('confirm-modal').classList.add('hidden');
        confirmActionCallback = null;
    }, 300);
}

function initEditor() {
    if (!scriptEditor) {
        scriptEditor = CodeMirror.fromTextArea(document.getElementById('config-script'), {
            mode: 'shell',
            theme: 'ayu-dark',
            lineNumbers: true,
            lineWrapping: true
        });

        document.getElementById('config-type').addEventListener('change', (e) => {
            if (scriptEditor) {
                scriptEditor.setOption("mode", e.target.value === 'powershell' ? 'powershell' : 'shell');
            }
        });
    }
}

async function fetchData() {
    try {
        const res = await fetch('/api/configurations');
        configurations = await res.json();
        render();
    } catch (err) {
        console.error('Error fetching data:', err);
        alert('Failed to fetch data from the server.');
    }
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, exp)).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function escapeAttr(str) {
    // For use in HTML attribute values encoded as JSON (double-quoted context)
    return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function dependencyChip(dep) {
    const name = typeof dep === 'string' ? dep : dep.name;
    const vars = typeof dep === 'string' ? null : dep.vars;
    const varsText = vars && Object.keys(vars).length
        ? ` {${Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join(', ')}}`
        : '';
    return `<span class="px-2.5 py-1 rounded-md text-[10px] font-mono well text-[var(--text-muted)]">${name}${varsText}</span>`;
}

function render() {
    const list = document.getElementById('vuln-list');
    const searchTerm = document.getElementById('search-input')?.value.toLowerCase() || '';
    const filterPlatform = document.getElementById('filter-platform')?.value || '';

    list.innerHTML = '';

    // Keep the dependency-name autocomplete list in sync
    const datalist = document.getElementById('configuration-names');
    if (datalist) {
        datalist.innerHTML = configurations.map(c => `<option value="${escapeAttr(c.name)}"></option>`).join('');
    }

    let filtered = configurations.filter(config => {
        // Search covers the description too — it's prose, so it's usually the only place a
        // word like "firewall" or "anonymous" appears for a config whose slug doesn't say so.
        const haystack = `${config.name} ${config.description || ''}`.toLowerCase();
        const matchesSearch = haystack.includes(searchTerm);
        const matchesPlatform = filterPlatform === '' || config.platform === filterPlatform;
        const matchesCategory = activeCategory === '' || config.category === activeCategory;
        return matchesSearch && matchesPlatform && matchesCategory;
    });

    if (filtered.length === 0) {
        list.innerHTML = '<div class="col-span-full text-center text-[var(--text-faint)] py-10 well rounded-xl mx-4">No configurations found matching your criteria.</div>';
        return;
    }

    filtered.forEach(config => {
        const isService = config.category === 'service';
        const hasDeps = config.depends_on && config.depends_on.length;
        // Base64-encoded JSON for safe data attribute storage (avoids inline onclick handlers,
        // which meant any of these fields could inject arbitrary JS into the page).
        const encodedJson = btoa(unescape(encodeURIComponent(JSON.stringify(config))));

        const card = document.createElement('div');
        card.className = 'card rounded-xl p-4 flex flex-col';
        card.dataset.config = encodedJson;

        const scriptBlock = `<pre class="text-xs font-mono text-[var(--text)] bg-[var(--code-bg)] border border-[var(--code-border)] p-3 rounded-md overflow-x-auto leading-relaxed mb-3"><code class="language-${config.type === 'powershell' ? 'powershell' : config.type === 'bash' ? 'bash' : 'dos'}">${escapeHtml(config.script)}</code></pre>`;

        card.innerHTML = `
            <div class="flex justify-between items-start mb-3">
                <div>
                    <h3 class="text-base font-bold text-[var(--text)] mb-1.5 tracking-wide">${escapeHtml(config.name)}</h3>
                    <span class="inline-flex gap-1.5 flex-wrap">
                        <span class="px-2.5 py-1 rounded-md text-[10px] font-bold text-glow-pink well uppercase tracking-wider">${escapeHtml(config.category)}</span>
                        <span class="px-2.5 py-1 rounded-md text-[10px] font-bold text-glow-cyan well uppercase tracking-wider">${escapeHtml(config.platform)}</span>
                        <span class="px-2.5 py-1 rounded-md text-[10px] font-bold well uppercase tracking-wider">${escapeHtml(config.run_as)}</span>
                        ${config.attachments && config.attachments.length ? `<span class="px-2.5 py-1 rounded-md text-[10px] font-bold well uppercase tracking-wider" title="${config.attachments.length} attachment(s)">&#128206; ${config.attachments.length}</span>` : ''}
                    </span>
                    ${isService && hasDeps ? `<div class="flex flex-wrap gap-1 mt-2">${config.depends_on.map(dependencyChip).join('')}</div>` : ''}
                </div>
                <div class="flex gap-2 shrink-0">
                    <button data-action="edit" class="p-2 btn rounded-lg text-glow-cyan" title="Edit Configuration">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                    <button data-action="delete" class="p-2 btn rounded-lg text-[var(--accent-pink)]" title="Delete Configuration">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                </div>
            </div>

            ${config.description
                ? `<p class="text-xs text-[var(--text-muted)] leading-relaxed mb-3">${escapeHtml(config.description)}</p>`
                : `<p class="text-xs text-[var(--text-faint)] italic mb-3">No description — agents picking a misconfig set have nothing to go on for this one.</p>`}

            ${isService ? `<button type="button" data-action="edit" class="text-[10px] btn px-2.5 py-1.5 rounded-md text-glow-cyan font-bold uppercase tracking-wide self-start mb-1">View / Edit Script</button>` : scriptBlock}

            ${!isService && hasDeps ? `
                <div>
                    <h4 class="text-xs font-bold text-[var(--text-faint)] uppercase tracking-wider mb-2">Depends On</h4>
                    <div class="flex flex-wrap gap-1.5">${config.depends_on.map(dependencyChip).join('')}</div>
                </div>
            ` : ''}
        `;

        list.appendChild(card);
    });

    // Apply syntax highlighting
    document.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
    });
}

// Event delegation for card actions (edit/delete) — replaces inline onclick handlers so
// config data never gets interpolated directly into a JS attribute context.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const card = btn.closest('[data-config]');
    if (!card) return;

    const config = JSON.parse(decodeURIComponent(escape(atob(card.dataset.config))));

    if (btn.dataset.action === 'edit') {
        editConfig(config);
    } else if (btn.dataset.action === 'delete') {
        deleteConfig(config.id);
    }
});

// Dependency-row widget logic
function addVarRow(varsContainer, key = '', value = '') {
    const row = document.createElement('div');
    row.className = 'flex gap-2 var-row mt-1.5 min-w-0';
    row.innerHTML = `
        <input type="text" class="var-key flex-1 min-w-0 input-field rounded-lg px-3 py-1.5 text-xs" placeholder="KEY" value="${key}">
        <input type="text" class="var-value flex-1 min-w-0 input-field rounded-lg px-3 py-1.5 text-xs" placeholder="value" value="${value}">
        <button type="button" class="btn p-1.5 rounded-lg text-[var(--accent-pink)] shrink-0" title="Remove variable">&times;</button>
    `;
    row.querySelector('button').addEventListener('click', () => row.remove());
    varsContainer.appendChild(row);
}

function moveDependencyRow(row, direction) {
    const sibling = direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (direction === 'up') {
        sibling.before(row);
    } else {
        sibling.after(row);
    }
}

function addDependencyRow(name = '', vars = {}) {
    const container = document.getElementById('dependency-rows');
    const row = document.createElement('div');
    row.className = 'well rounded-lg p-3 dependency-row min-w-0';
    row.innerHTML = `
        <div class="flex gap-2 mb-1.5 min-w-0">
            <div class="flex flex-col gap-0.5 shrink-0">
                <button type="button" class="btn px-1.5 rounded-md text-[var(--text-faint)] move-up-btn leading-none" title="Move up">&uarr;</button>
                <button type="button" class="btn px-1.5 rounded-md text-[var(--text-faint)] move-down-btn leading-none" title="Move down">&darr;</button>
            </div>
            <input type="text" class="dep-name flex-1 min-w-0 input-field rounded-lg px-3 py-2 text-sm" placeholder="configuration name or package" list="configuration-names" value="${name}">
            <button type="button" class="btn p-2 rounded-lg text-[var(--accent-pink)] shrink-0" title="Remove dependency">&times;</button>
        </div>
        <div class="dep-vars min-w-0"></div>
        <button type="button" class="text-[10px] btn px-2 py-1 rounded-md text-glow-cyan font-bold uppercase tracking-wide add-var-btn mt-1">+ Variable</button>
    `;
    row.querySelector('button[title="Remove dependency"]').addEventListener('click', () => row.remove());
    row.querySelector('.move-up-btn').addEventListener('click', () => moveDependencyRow(row, 'up'));
    row.querySelector('.move-down-btn').addEventListener('click', () => moveDependencyRow(row, 'down'));

    const varsContainer = row.querySelector('.dep-vars');
    Object.entries(vars).forEach(([key, value]) => addVarRow(varsContainer, key, value));

    row.querySelector('.add-var-btn').addEventListener('click', () => addVarRow(varsContainer));

    container.appendChild(row);
}

function collectDependencies() {
    const rows = document.querySelectorAll('#dependency-rows .dependency-row');
    const depends_on = [];
    rows.forEach(row => {
        const name = row.querySelector('.dep-name').value.trim();
        if (!name) return;

        const vars = {};
        row.querySelectorAll('.var-row').forEach(varRow => {
            const key = varRow.querySelector('.var-key').value.trim();
            const value = varRow.querySelector('.var-value').value.trim();
            if (key) vars[key] = value;
        });

        depends_on.push(Object.keys(vars).length ? { name, vars } : name);
    });
    return depends_on;
}

// Attachment widget logic
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAttachments(attachments) {
    const container = document.getElementById('attachment-rows');
    container.innerHTML = (attachments || []).map(a => `
        <div class="well rounded-lg p-2.5 flex items-center justify-between gap-2 min-w-0" data-attachment-id="${a.id}">
            <a href="/api/attachments/${a.id}/download" class="attachment-name text-xs font-mono text-[var(--text)] hover:text-glow-cyan truncate min-w-0">${escapeHtml(a.original_name)}</a>
            <div class="flex items-center gap-2 shrink-0">
                <span class="text-[10px] text-[var(--text-faint)]">${formatBytes(a.size_bytes)}</span>
                <button type="button" onclick="renameAttachment(${a.id})" class="p-1 btn rounded-md text-glow-cyan" title="Rename attachment">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                </button>
                <button type="button" onclick="deleteAttachment(${a.id})" class="p-1 btn rounded-md text-[var(--accent-pink)]" title="Delete attachment">&times;</button>
            </div>
        </div>
    `).join('') || '<p class="text-[10px] text-[var(--text-faint)]">No attachments yet.</p>';
}

function setAttachmentsEnabled(enabled) {
    document.getElementById('attachment-upload-btn').disabled = !enabled;
    document.getElementById('attachment-upload-btn').classList.toggle('opacity-40', !enabled);
    document.getElementById('attachment-hint').classList.toggle('hidden', enabled);
    if (!enabled) document.getElementById('attachment-rows').innerHTML = '';
}

function refreshAttachmentsView() {
    const configId = document.getElementById('config-id').value;
    renderAttachments((configurations.find(c => c.id == configId) || {}).attachments);
}

async function uploadAttachment(file) {
    const configId = document.getElementById('config-id').value;
    if (!configId || !file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`/api/configurations/${configId}/attachments`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Server error');
        await fetchData();
        refreshAttachmentsView();
    } catch (err) {
        alert('Error uploading attachment');
        console.error(err);
    }
}

function renameAttachment(id) {
    const row = document.querySelector(`[data-attachment-id="${id}"]`);
    const anchor = row.querySelector('.attachment-name');
    const currentName = anchor.textContent;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'attachment-name-input flex-1 min-w-0 input-field rounded-md px-2 py-1 text-xs font-mono';
    anchor.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = async () => {
        if (settled) return;
        settled = true;

        const newName = input.value.trim();
        if (!newName || newName === currentName) {
            refreshAttachmentsView();
            return;
        }

        try {
            const res = await fetch('/api/attachments/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ original_name: newName })
            });
            if (!res.ok) throw new Error('Server error');
            await fetchData();
        } catch (err) {
            alert('Error renaming attachment');
            console.error(err);
        }
        refreshAttachmentsView();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            settled = true;
            refreshAttachmentsView();
        }
    });
    input.addEventListener('blur', commit);
}

function deleteAttachment(id) {
    showConfirmModal(
        'Delete Attachment',
        'Are you sure you want to delete this attachment?',
        async () => {
            try {
                const res = await fetch('/api/attachments/' + id, { method: 'DELETE' });
                if (!res.ok) throw new Error('Server error');
                await fetchData();
                refreshAttachmentsView();
            } catch (err) {
                alert('Error deleting attachment');
                console.error(err);
            }
        }
    );
}

// Configuration Modal Logic
function openConfigModal(config = null) {
    document.getElementById('config-modal').classList.remove('hidden');
    setTimeout(() => {
        document.querySelector('#config-modal .card').classList.add('modal-enter-active');
    }, 10);

    initEditor();
    document.getElementById('dependency-rows').innerHTML = '';

    if (config) {
        document.getElementById('config-modal-title').innerText = 'Edit Configuration';
        document.getElementById('config-id').value = config.id;
        document.getElementById('config-name').value = config.name;
        document.getElementById('config-description').value = config.description || '';
        document.getElementById('config-platform').value = config.platform;
        document.getElementById('config-category').value = config.category;
        document.getElementById('config-type').value = config.type;
        document.getElementById('config-run-as').value = config.run_as;
        scriptEditor.setValue(config.script);
        scriptEditor.setOption("mode", config.type === 'powershell' ? 'powershell' : 'shell');

        (config.depends_on || []).forEach(dep => {
            if (typeof dep === 'string') addDependencyRow(dep);
            else addDependencyRow(dep.name, dep.vars || {});
        });

        setAttachmentsEnabled(true);
        renderAttachments(config.attachments);
    } else {
        document.getElementById('config-modal-title').innerText = 'Add Configuration';
        document.getElementById('config-form').reset();
        document.getElementById('config-id').value = '';
        scriptEditor.setValue('');
        setAttachmentsEnabled(false);
    }

    setTimeout(() => scriptEditor.refresh(), 50);
}

function closeConfigModal() {
    document.querySelector('#config-modal .card').classList.remove('modal-enter-active');
    setTimeout(() => {
        document.getElementById('config-modal').classList.add('hidden');
    }, 300);
}

async function saveConfig(e) {
    e.preventDefault();
    const scriptContent = scriptEditor.getValue().trim();
    const dependencies = collectDependencies();
    // An empty script is legitimate when the config does all its work through depends_on
    // (suid-vim is just install-package PACKAGE=vim). Blocking those outright meant they could
    // never be edited through the UI at all — including to give them a description.
    if (!scriptContent && !dependencies.length) {
        alert("A configuration needs either a script or at least one dependency.");
        return;
    }

    const id = document.getElementById('config-id').value;
    const description = document.getElementById('config-description').value.trim();
    const data = {
        name: document.getElementById('config-name').value,
        description: description || null,
        platform: document.getElementById('config-platform').value,
        category: document.getElementById('config-category').value,
        type: document.getElementById('config-type').value,
        run_as: document.getElementById('config-run-as').value.trim() || 'root',
        script: scriptContent,
        depends_on: dependencies
    };

    const method = id ? 'PUT' : 'POST';
    const url = id ? '/api/configurations/' + id : '/api/configurations';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            // The API validates platform/category/type and returns a 400 saying which one is
            // wrong; showing "Server error" instead would throw that away.
            const body = await res.json().catch(() => null);
            throw new Error(body && body.error ? body.error : `Server error (${res.status})`);
        }
        closeConfigModal();
        fetchData();
    } catch (err) {
        alert(`Error saving configuration: ${err.message}`);
        console.error(err);
    }
}

function editConfig(config) {
    openConfigModal(config);
}

function deleteConfig(id) {
    showConfirmModal(
        'Delete Configuration',
        'Are you sure you want to delete this configuration?',
        async () => {
            try {
                const res = await fetch('/api/configurations/' + id, { method: 'DELETE' });
                if (res.status === 409) {
                    const body = await res.json();
                    alert(`Can't delete — still depended on by: ${body.dependents.join(', ')}`);
                    return;
                }
                if (!res.ok) throw new Error('Server error');
                fetchData();
            } catch (err) {
                alert('Error deleting');
                console.error(err);
            }
        }
    );
}

// Event listeners for search, filters
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

    document.getElementById('search-input')?.addEventListener('input', render);
    document.getElementById('filter-platform')?.addEventListener('change', render);

    document.querySelectorAll('#category-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeCategory = btn.dataset.category;
            document.querySelectorAll('#category-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            render();
        });
    });
    document.querySelector('#category-tabs .tab-btn[data-category=""]')?.classList.add('active');

    document.getElementById('attachment-upload-btn')?.addEventListener('click', () => {
        if (!document.getElementById('attachment-upload-btn').disabled) {
            document.getElementById('attachment-file-input').click();
        }
    });
    document.getElementById('attachment-file-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        uploadAttachment(file);
        e.target.value = '';
    });

    document.getElementById('confirm-modal-btn')?.addEventListener('click', () => {
        if (confirmActionCallback) {
            confirmActionCallback();
        }
        closeConfirmModal();
    });
});

// Initial fetch
fetchData();

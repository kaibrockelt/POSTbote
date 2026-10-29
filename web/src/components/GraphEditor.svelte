<script>
  // Node workflow editor: drag nodes, connect an output port to another node,
  // configure the selected node on the right, run and inspect every step.
  import CodeArea from './CodeArea.svelte';
  import PathField from './PathField.svelte';
  import FileEditor from './FileEditor.svelte';
  import { fileDoc } from '../lib/doc.svelte.js';
  import { parseGraph, serializeGraph, parseRequest, GRAPH_EXT } from '../lib/format.js';
  import { allRequests } from '../lib/tree.js';
  import { NODE_TYPES, outsOf, uniqueNodeId, checkGraph } from '../lib/graph.js';
  import { app, run, cancelRun, select, contentOf } from '../lib/state.svelte.js';

  let { path } = $props();
  const d = fileDoc(path, parseGraph, serializeGraph);

  const W = 200; // node width
  const HEAD = 30;
  const ROW = 22;
  // nodes run by a For each: no ports, the loop feeds them and collects their output
  const loopOf = (n) => d.doc?.nodes.find((f) => f.type === 'forEach' && f.child === n.id);
  const nodeHeight = (n) => HEAD + (loopOf(n) ? 1 : Math.max(1, outsOf(n).length)) * ROW + 8;
  const inPos = (n) => ({ x: n.x, y: n.y + HEAD / 2 });
  const outPos = (n, port) => ({ x: n.x + W, y: n.y + HEAD + 12 + (loopOf(n) ? 0 : Math.max(0, outsOf(n).indexOf(port)) * ROW) });

  let canvas = $state();
  let pan = $state({ x: 40, y: 40 });
  let viewW = $state(800); // visible canvas size (bound to the element)
  let viewH = $state(500);
  let navTab = $state('map');
  let selected = $state(null); // { kind: 'node' | 'edge', id | index }
  let drag = null; // node move, pan or new link
  let link = $state(null); // { from, out, x, y } while dragging a new edge
  let starter = $state('');

  const requests = $derived(allRequests(app.files));
  // declared variables (parameters) of a request, filled from the node input
  const requestVars = (path) => (path && path in app.files ? parseRequest(contentOf(path)).doc?.variables.filter((v) => v.key) || [] : []);
  const callable = $derived(
    Object.keys(app.files)
      .filter((p) => p.startsWith('workflows/') && p.endsWith(GRAPH_EXT) && p !== path)
      .filter((p) => parseGraph(app.files[p]).doc?.nodes.some((n) => n.type === 'fromWorkflow'))
      .sort(),
  );
  const starters = $derived(d.doc?.nodes.filter((n) => n.type === 'manual') ?? []);
  const running = $derived(!!app.running[path]);
  const result = $derived(app.results[path]?.graph);
  // last step per node (forEach children appear once per item; the last one wins)
  const stepOf = $derived(Object.fromEntries((result?.steps || []).map((s) => [s.node, s])));
  const node = $derived(selected?.kind === 'node' ? d.doc?.nodes.find((n) => n.id === selected.id) : null);
  // problems found before running (missing requests, unconnected nodes, …)
  const issues = $derived(d.doc ? checkGraph($state.snapshot(d.doc), (p) => p in app.files) : { nodes: {}, general: [] });

  const byId = (id) => d.doc.nodes.find((n) => n.id === id);
  const curve = (a, b) => `M${a.x} ${a.y} C${a.x + 70} ${a.y}, ${b.x - 70} ${b.y}, ${b.x} ${b.y}`;
  const world = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left - pan.x, y: e.clientY - r.top - pan.y };
  };

  function addNode(type, at) {
    const id = uniqueNodeId(d.doc, type);
    if (at) {
      d.doc.nodes.push({ id, type, name: NODE_TYPES[type].label, x: Math.round(at.x / 10) * 10, y: Math.round(at.y / 10) * 10, ...structuredClone(NODE_TYPES[type].init) });
      selected = { kind: 'node', id };
      return;
    }
    // the free spot closest to the middle of what is visible (rings around it)
    const h = HEAD + 2 * ROW + 8;
    const cx = -pan.x + viewW / 2 - W / 2;
    const cy = -pan.y + viewH / 2 - h / 2;
    const free = (x, y) => !d.doc.nodes.some((n) => x < n.x + W + 20 && x + W + 20 > n.x && y < n.y + nodeHeight(n) + 20 && y + h + 20 > n.y);
    const visible = (x, y) => x >= -pan.x + 10 && x + W <= -pan.x + viewW - 10 && y >= -pan.y + 10 && y + h <= -pan.y + viewH - 10;
    let spot = { x: cx, y: cy };
    // first a free spot that is fully visible, else the nearest free one
    search: for (const mustSee of [true, false]) {
      for (let r = 0; r < 8; r++) {
        for (let i = -r; i <= r; i++) {
          for (let j = -r; j <= r; j++) {
            if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
            const x = cx + i * (W / 2 + 20);
            const y = cy + j * (h / 2 + 15);
            if (free(x, y) && (!mustSee || visible(x, y))) {
              spot = { x, y };
              break search;
            }
          }
        }
      }
    }
    d.doc.nodes.push({ id, type, name: NODE_TYPES[type].label, x: Math.round(spot.x / 10) * 10, y: Math.round(spot.y / 10) * 10, ...structuredClone(NODE_TYPES[type].init) });
    selected = { kind: 'node', id };
  }

  // ---- palette: a click places the node in view, dragging drops it where the pointer is
  let ghost = $state(null); // { type, x, y, over } while dragging a new node (screen coordinates)
  let paletteDrag = null;
  function paletteDown(e, type) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    paletteDrag = { type, sx: e.clientX, sy: e.clientY };
    window.addEventListener('pointermove', paletteMove);
    window.addEventListener('pointerup', paletteUp, { once: true });
  }
  function paletteMove(e) {
    if (!paletteDrag) return;
    if (!ghost && Math.hypot(e.clientX - paletteDrag.sx, e.clientY - paletteDrag.sy) < 4) return;
    const r = canvas.getBoundingClientRect();
    const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    ghost = { type: paletteDrag.type, x: e.clientX, y: e.clientY, over };
  }
  function paletteUp(e) {
    window.removeEventListener('pointermove', paletteMove);
    const type = paletteDrag?.type;
    paletteDrag = null;
    if (!ghost) return addNode(type); // a click
    const over = ghost.over;
    ghost = null;
    // the pointer holds the node by the middle of its head
    if (over) {
      const p = world(e);
      addNode(type, { x: p.x - W / 2, y: p.y - HEAD / 2 });
    }
  }

  /** Centres the view on a node and selects it. */
  function focusNode(n) {
    pan = { x: Math.round(viewW / 2 - (n.x + W / 2)), y: Math.round(viewH / 2 - (n.y + nodeHeight(n) / 2)) };
    selected = { kind: 'node', id: n.id };
  }

  // ---- navigator: minimap of all nodes plus the visible area
  const view = $derived({ x: -pan.x, y: -pan.y, w: viewW, h: viewH });
  const bounds = $derived.by(() => {
    const boxes = [view, ...(d.doc?.nodes || []).map((n) => ({ x: n.x, y: n.y, w: W, h: nodeHeight(n) }))];
    const x1 = Math.min(...boxes.map((b) => b.x)) - 60;
    const y1 = Math.min(...boxes.map((b) => b.y)) - 60;
    const x2 = Math.max(...boxes.map((b) => b.x + b.w)) + 60;
    const y2 = Math.max(...boxes.map((b) => b.y + b.h)) + 60;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  });
  let minimap = $state();
  let mapDrag = null;
  const mapPoint = (e) => {
    const p = minimap.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(minimap.getScreenCTM().inverse());
  };
  function mapDown(e) {
    const p = mapPoint(e);
    const inside = p.x >= view.x && p.x <= view.x + view.w && p.y >= view.y && p.y <= view.y + view.h;
    // grab the rectangle where it was hit, or centre it on the click
    mapDrag = inside ? { dx: p.x - view.x, dy: p.y - view.y } : { dx: view.w / 2, dy: view.h / 2 };
    mapMove(e);
    window.addEventListener('pointermove', mapMove);
    window.addEventListener('pointerup', () => ((mapDrag = null), window.removeEventListener('pointermove', mapMove)), { once: true });
  }
  function mapMove(e) {
    if (!mapDrag) return;
    const p = mapPoint(e);
    pan = { x: Math.round(-(p.x - mapDrag.dx)), y: Math.round(-(p.y - mapDrag.dy)) };
  }

  const GROUPS = ['Start', 'Actions', 'Control', 'Files', 'End'];
  const nodeGroups = $derived(
    Object.entries(NODE_TYPES)
      .sort((a, b) => GROUPS.indexOf(a[1].group) - GROUPS.indexOf(b[1].group))
      .map(([type, t]) => ({
        type,
        label: t.label,
        nodes: (d.doc?.nodes || []).filter((n) => n.type === type).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true })),
      }))
      .filter((g) => g.nodes.length),
  );

  function removeSelected() {
    if (!selected) return;
    if (selected.kind === 'edge') d.doc.edges.splice(selected.index, 1);
    else {
      d.doc.nodes = d.doc.nodes.filter((n) => n.id !== selected.id);
      d.doc.edges = d.doc.edges.filter((e) => e.from !== selected.id && e.to !== selected.id);
      for (const n of d.doc.nodes) if (n.child === selected.id) n.child = '';
    }
    selected = null;
  }

  function startMove(e, n) {
    if (e.button !== 0) return;
    e.stopPropagation();
    selected = { kind: 'node', id: n.id };
    const p = world(e);
    drag = { mode: 'node', id: n.id, dx: p.x - n.x, dy: p.y - n.y };
    window.addEventListener('pointermove', onmove);
    window.addEventListener('pointerup', onup, { once: true });
  }

  function startLink(e, n, out) {
    e.stopPropagation();
    const p = world(e);
    drag = { mode: 'link' };
    link = { from: n.id, out, ...p };
    window.addEventListener('pointermove', onmove);
    window.addEventListener('pointerup', onup, { once: true });
  }

  function startPan(e) {
    if (e.button !== 0 || e.target.closest('.node')) return;
    selected = null;
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    window.addEventListener('pointermove', onmove);
    window.addEventListener('pointerup', onup, { once: true });
  }

  function onmove(e) {
    if (!drag) return;
    if (drag.mode === 'pan') pan = { x: drag.px + e.clientX - drag.sx, y: drag.py + e.clientY - drag.sy };
    else if (drag.mode === 'node') {
      const n = byId(drag.id);
      const p = world(e);
      if (n) {
        n.x = Math.round((p.x - drag.dx) / 10) * 10;
        n.y = Math.round((p.y - drag.dy) / 10) * 10;
      }
    } else if (drag.mode === 'link' && link) Object.assign(link, world(e));
  }

  function onup(e) {
    window.removeEventListener('pointermove', onmove);
    if (drag?.mode === 'link' && link) {
      // dropped on a node: connect (starters have no input, no duplicates, no self links)
      const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node')?.dataset.id;
      const target = id && byId(id);
      if (target && id !== link.from && !NODE_TYPES[target.type]?.starter && !loopOf(target) && !d.doc.edges.some((x) => x.from === link.from && x.out === link.out && x.to === id)) {
        d.doc.edges.push({ from: link.from, out: link.out, to: id });
      }
      link = null;
    }
    drag = null;
  }

  function onkeydown(e) {
    if (!selected || app.dialog || !(e.key === 'Delete' || e.key === 'Backspace')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    removeSelected();
  }

  const start = () => (running ? cancelRun(path) : run('graph', path, { starter: starter || undefined }));
  const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
</script>

<svelte:window {onkeydown} />

{#if d.error}
  <div class="error-box">Cannot parse this workflow: {d.error}</div>
  <FileEditor {path} />
{:else if d.doc}
  <div class="graph-page">
    <div class="row between head">
      <input class="title grow" bind:value={d.doc.name} placeholder="Workflow name" />
      {#if starters.length > 1}
        <select bind:value={starter} title="Starter node">
          <option value="">{starters[0].name || starters[0].id}</option>
          {#each starters.slice(1) as s (s.id)}<option value={s.id}>{s.name || s.id}</option>{/each}
        </select>
      {/if}
      <button class="primary" onclick={start}>{running ? 'Cancel' : '▶ Run'}</button>
    </div>

    <div class="layout">
      <div class="palette">
        {#each ['Start', 'Actions', 'Control', 'Files', 'End'] as group (group)}
          <div class="group">{group}</div>
          {#each Object.entries(NODE_TYPES).filter(([, t]) => t.group === group) as [type, t] (type)}
            <button class="small add" onpointerdown={(e) => paletteDown(e, type)} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), addNode(type))}>＋ {t.label}</button>
          {/each}
        {/each}
        <p class="hint">Click a node type or drag it onto the canvas. Drag from an output dot onto another node to connect. Select and press Delete to remove.</p>
      </div>

      <div class="canvas" bind:this={canvas} bind:clientWidth={viewW} bind:clientHeight={viewH} onpointerdown={startPan} role="application" aria-label="Workflow canvas">
        <div class="world" style="transform: translate({pan.x}px, {pan.y}px)">
          <!-- large enough to receive clicks on edges anywhere; the group puts 0,0 at the world origin -->
          <svg class="edges" width="8000" height="8000"><g transform="translate(4000 4000)">
            {#each d.doc.edges as e, i (`${e.from}:${e.out}:${e.to}:${i}`)}
              {@const a = byId(e.from)}
              {@const b = byId(e.to)}
              {#if a && b}
                {@const path = curve(outPos(a, e.out), inPos(b))}
                <path d={path} class="hit" role="button" tabindex="-1" aria-label="edge" onpointerdown={(ev) => { ev.stopPropagation(); selected = { kind: 'edge', index: i }; }} />
                <path d={path} class="edge" class:err={e.out === 'err'} class:sel={selected?.kind === 'edge' && selected.index === i} />
              {/if}
            {/each}
            <!-- for each: the node run per item -->
            {#each d.doc.nodes.filter((n) => n.type === 'forEach' && n.child) as f (f.id)}
              {@const c = byId(f.child)}
              {#if c}<path d={curve({ x: f.x + W / 2, y: f.y + nodeHeight(f) }, { x: c.x + W / 2, y: c.y })} class="edge child" />{/if}
            {/each}
            {#if link}
              {@const a = byId(link.from)}
              {#if a}<path d={curve(outPos(a, link.out), link)} class="edge draft" />{/if}
            {/if}
          </g></svg>

          {#each d.doc.nodes as n (n.id)}
            {@const t = NODE_TYPES[n.type]}
            {@const st = stepOf[n.id]}
            {@const loop = loopOf(n)}
            <div
              class="node"
              class:sel={selected?.kind === 'node' && selected.id === n.id}
              class:ok={st && !st.error}
              class:failed={st?.error}
              class:warn={issues.nodes[n.id] && !st}
              title={issues.nodes[n.id]?.join('\n') || ''}
              data-id={n.id}
              style="left: {n.x}px; top: {n.y}px; width: {W}px; height: {nodeHeight(n)}px"
            >
              <div class="node-head" role="button" tabindex="-1" onpointerdown={(e) => startMove(e, n)}>
                {#if !t?.starter && !loop}<span class="port in" title="input{n.input ? ` (${n.input})` : ''}"></span>{/if}
                {#if issues.nodes[n.id]}<span class="warn-mark" title={issues.nodes[n.id].join('\n')}>!</span>{/if}
                <span class="node-title">{n.name || t?.label || n.type}</span>
                <span class="node-type">{t?.label || n.type}</span>
              </div>
              {#if loop}
                <div class="loop-row" style="top: {HEAD + 1}px" title="run by {loop.name || loop.id} for every item">↻ runs once per item</div>
              {/if}
              {#each loop ? [] : outsOf(n) as out, i (out)}
                <div class="out-row" style="top: {HEAD + 1 + i * ROW}px">
                  <span class="out-label" class:err={out === 'err'} class:taken={st?.port === out}>{out}</span>
                  <span class="port out" class:err={out === 'err'} role="button" tabindex="-1" title="drag to connect" onpointerdown={(e) => startLink(e, n, out)}></span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>

      {#if ghost}
        <div class="node ghost" class:off={!ghost.over} style="left: {ghost.x - W / 2}px; top: {ghost.y - HEAD / 2}px; width: {W}px">
          <div class="node-head"><span class="node-title">{NODE_TYPES[ghost.type].label}</span></div>
        </div>
      {/if}

      <div class="side">
      <div class="panel">
        {#if node}
          {@const t = NODE_TYPES[node.type]}
          <div class="row between"><b>{t?.label || node.type}</b><span class="muted small mono">{node.id}</span></div>
          {#if issues.nodes[node.id]}
            <ul class="issues">
              {#each issues.nodes[node.id] as m (m)}<li>{m}</li>{/each}
            </ul>
          {/if}
          <label><span>Name</span><input bind:value={node.name} /></label>
          {#if t?.inputs.length}
            <label>
              <span>Input type</span>
              <select bind:value={node.input}>
                {#if node.input && !t.inputs.includes(node.input)}<option value={node.input}>{node.input} (not useful here)</option>{/if}
                {#each t.inputs as it (it)}<option value={it}>{it || 'any'}</option>{/each}
              </select>
            </label>
          {/if}

          {#if node.type === 'manual'}
            <label><span>Payload</span><select bind:value={node.payloadType}><option value="json">JSON</option><option value="csv">CSV (header row → JSON rows)</option><option value="text">text</option></select></label>
            <CodeArea bind:value={node.payload} rows={8} placeholder={node.payloadType === 'csv' ? 'id,name\n1,ada\n2,grace' : '[\n  { "id": "kai" },\n  { "id": "kaisen" }\n]'} />
          {:else if node.type === 'request'}
            <label>
              <span>Request</span>
              <select bind:value={node.request}>
                <option value="">— choose —</option>
                {#if node.request && !requests.some((r) => r.path === node.request)}<option value={node.request}>⚠ {node.request} (missing)</option>{/if}
                {#each requests as r (r.path)}<option value={r.path}>{r.method} · {r.name} — {r.path.slice(9)}</option>{/each}
              </select>
            </label>
            <label class="check"><input type="checkbox" checked={node.useFolder !== false} onchange={(e) => (node.useFolder = e.currentTarget.checked)} /> use folder settings (variables, headers, auth, scripts)</label>
            <label class="check"><input type="checkbox" checked={node.failOnError !== false} onchange={(e) => (node.failOnError = e.currentTarget.checked)} /> HTTP status ≥ 400 or a failed test goes to err</label>
            <label>
              <span>Output</span>
              <select value={node.output || 'body'} onchange={(e) => (node.output = e.currentTarget.value)}>
                <option value="body">response body</option>
                <option value="response">whole response {'{ status, headers, body }'}</option>
              </select>
            </label>
            {@const params = requestVars(node.request)}
            {#if params.length}
              <div class="params">
                <span class="muted small">Parameters, filled from the input's fields:</span>
                {#each params as v (v.key)}
                  <div class="param mono small">{v.key === 'input' ? 'input (sample, replaced by the node input)' : v.key}{#if v.value && v.key !== 'input'} <span class="muted">= {v.value}</span>{/if}</div>
                {/each}
              </div>
            {:else if node.request}
              <p class="hint">The request declares no variables. Add them in its Variables tab; a JSON input fills those with the same name.</p>
            {/if}
            <p class="hint">Only the request's variables are filled, never folder, collection or environment values. <code>{'{{input}}'}</code> / <code>{'{{input.field}}'}</code> read the input directly.</p>
            {#if node.request}<button class="link small" onclick={() => select({ kind: 'request', path: node.request })}>Open request ↗</button>{/if}
          {:else if node.type === 'script'}
            <span class="muted small">Code — <code>input</code> is the incoming value; <code>return</code> the output, <code>throw</code> goes to err</span>
            <CodeArea bind:value={node.code} rows={12} />
          {:else if node.type === 'switch'}
            <span class="muted small">Cases (first match wins, else <code>default</code>); the input passes on unchanged</span>
            {#each node.cases as c, i (i)}
              <div class="case">
                <input class="mono" bind:value={c.name} placeholder="port" />
                <input class="mono grow" bind:value={c.expr} placeholder="input.status === 'active'" />
                <button class="icon" title="Remove case" onclick={() => node.cases.splice(i, 1)}>✕</button>
              </div>
            {/each}
            <button class="small" onclick={() => node.cases.push({ name: `case${node.cases.length + 1}`, expr: '' })}>＋ Case</button>
          {:else if node.type === 'forEach'}
            <label>
              <span>Run for every item</span>
              <select bind:value={node.child}>
                <option value="">— choose a node —</option>
                {#if node.child && !d.doc.nodes.some((n) => n.id === node.child)}<option value={node.child}>⚠ {node.child} (missing)</option>{/if}
                {#each d.doc.nodes.filter((n) => n.id !== node.id && !NODE_TYPES[n.type]?.starter) as n (n.id)}<option value={n.id}>{n.name || n.id}</option>{/each}
              </select>
            </label>
            <label class="check"><input type="checkbox" bind:checked={node.parallel} /> parallel</label>
            {#if node.parallel}
              <label><span>At most at the same time</span><input type="number" min="1" max="50" bind:value={node.limit} /></label>
              <p class="hint">Request nodes are sent at the same time (scripts still run one after another); other nodes run in order.</p>
            {/if}
            <p class="hint">Takes a JSON array or CSV. The chosen node runs once per item (its own edges are not followed); the outputs are collected as a JSON array.</p>
          {:else if node.type === 'setVar'}
            <label><span>Store in</span><select bind:value={node.scope}><option value="vars">run variable (vars, this run only)</option><option value="env">environment (private value, saved)</option></select></label>
            <label><span>Variable</span><input class="mono" bind:value={node.variable} placeholder="token" /></label>
            <label><span>Value</span><input class="mono" bind:value={node.value} placeholder={'{{input.access_token}} – empty = the whole input'} /></label>
            <p class="hint">Later requests use it as <code>{'{{'}{node.variable || 'name'}{'}}'}</code>. The input passes on unchanged.</p>
          {:else if node.type === 'filter'}
            <label><span>Keep items where</span><input class="mono" bind:value={node.expr} placeholder="item.active && index < 10" /></label>
            <p class="hint">JavaScript with <code>item</code> and <code>index</code>; takes a JSON array or CSV, outputs the matching items.</p>
          {:else if node.type === 'assert'}
            <span class="muted small">All must be true (JavaScript with <code>input</code>), else the node goes to err</span>
            {#each node.checks as c, i (i)}
              <div class="case">
                <input class="mono grow" bind:value={c.expr} placeholder="input.status === 'ok'" />
                <input bind:value={c.message} placeholder="message" />
                <button class="icon" title="Remove check" onclick={() => node.checks.splice(i, 1)}>✕</button>
              </div>
            {/each}
            <button class="small" onclick={() => node.checks.push({ expr: '', message: '' })}>＋ Check</button>
            <p class="hint">An unconnected err stops the workflow, so a failed check makes CLI runs fail (exit code 1).</p>
          {:else if node.type === 'delay'}
            <label><span>Milliseconds</span><input class="mono" bind:value={node.ms} placeholder={'1000 or {{input.wait}}'} /></label>
          {:else if node.type === 'transform'}
            <span class="muted small">Template — JSON (or text) with <code>{'{{input.x}}'}</code> and other variables</span>
            <CodeArea bind:value={node.template} rows={10} />
            <p class="hint">Quote strings yourself: <code>{'"name": "{{input.name}}"'}</code>, numbers without quotes.</p>
          {:else if node.type === 'loadFile'}
            <label><span>Path</span><PathField bind:value={node.path} placeholder={'data/{{input.name}}.json'} /></label>
            <label><span>Parse as</span><select bind:value={node.parse}><option value="json">JSON</option><option value="csv">CSV</option><option value="text">text</option><option value="file">file</option></select></label>
          {:else if node.type === 'writeFile'}
            <label><span>Path</span><PathField bind:value={node.path} placeholder="out/result.json" /></label>
            <label><span>Format</span><select bind:value={node.format}><option value="json">JSON</option><option value="csv">CSV</option></select></label>
          {:else if node.type === 'workflow'}
            <label>
              <span>Workflow</span>
              <select bind:value={node.workflow}>
                <option value="">— choose —</option>
                {#if node.workflow && !callable.includes(node.workflow)}<option value={node.workflow}>⚠ {node.workflow} (missing or not callable)</option>{/if}
                {#each callable as p (p)}<option value={p}>{p.slice(10)}</option>{/each}
              </select>
            </label>
            <p class="hint">Only workflows with a “From workflow” starter can be called; their Return value is the output.</p>
          {:else if node.type === 'merge'}
            <label>
              <span>Output</span>
              <select bind:value={node.mode}>
                <option value="object">object keyed by input node id</option>
                <option value="array">array in connection order</option>
              </select>
            </label>
            <p class="hint">Waits until every connected node delivered a value, then continues once with all of them.</p>
          {:else if node.type === 'fromWorkflow'}
            <p class="hint">Starts this workflow when another workflow calls it; the caller's input is the output.</p>
          {:else if node.type === 'return'}
            <p class="hint">Ends the workflow and returns its input (to a calling workflow, or as the run result).</p>
          {/if}

          {#if stepOf[node.id]}
            {@const s = stepOf[node.id]}
            <div class="step">
              <div class="row between"><b>Last run</b><span class="muted small">{s.durationMs} ms → {s.port}</span></div>
              {#if s.error}<pre class="err-text">{s.error}</pre>{/if}
              {#if s.request?.response}<div class="muted small">HTTP {s.request.response.status} {s.request.request?.method} {s.request.request?.url}</div>{/if}
              <pre class="out">{s.output?.type}: {pretty(s.output?.value)}</pre>
            </div>
          {/if}
          <button class="small danger-outline" onclick={removeSelected}>Delete node</button>
        {:else if selected?.kind === 'edge'}
          <p>Connection selected.</p>
          <button class="small danger-outline" onclick={removeSelected}>Delete connection</button>
        {:else}
          {#each issues.general as m (m)}<p class="warn-text">{m}</p>{/each}
          <p class="muted">Select a node to configure it.</p>
          {#if result}
            <div class="step">
              <div class="row between"><b>Result</b><span class="muted small">{result.durationMs} ms · {result.steps.length} steps</span></div>
              {#if result.error}<pre class="err-text">{result.error}</pre>{:else}<pre class="out">{pretty(result.result ?? null)}</pre>{/if}
              {#each result.logs as l, i (i)}<div class="muted small mono">[{l.level}] {l.message}</div>{/each}
            </div>
          {/if}
        {/if}
      </div>

      <div class="navigator">
        <div class="nav-tabs">
          <button class:on={navTab === 'map'} onclick={() => (navTab = 'map')}>Map</button>
          <button class:on={navTab === 'nodes'} onclick={() => (navTab = 'nodes')}>Nodes <span class="muted">{d.doc.nodes.length}</span></button>
        </div>
        {#if navTab === 'map'}
          <svg class="minimap" bind:this={minimap} viewBox="{bounds.x} {bounds.y} {bounds.w} {bounds.h}" preserveAspectRatio="xMidYMid meet" onpointerdown={mapDown} role="img" aria-label="Map of the workflow">
            {#each d.doc.edges as e, i (i)}
              {@const a = byId(e.from)}
              {@const b = byId(e.to)}
              {#if a && b}<line x1={outPos(a, e.out).x} y1={outPos(a, e.out).y} x2={inPos(b).x} y2={inPos(b).y} class="map-edge" />{/if}
            {/each}
            {#each d.doc.nodes as n (n.id)}
              <rect
                x={n.x}
                y={n.y}
                width={W}
                height={nodeHeight(n)}
                rx="10"
                class="map-node"
                class:sel={selected?.kind === 'node' && selected.id === n.id}
                class:ok={stepOf[n.id] && !stepOf[n.id].error}
                class:failed={stepOf[n.id]?.error}
                class:warn={issues.nodes[n.id] && !stepOf[n.id]}
              />
            {/each}
            <rect x={view.x} y={view.y} width={view.w} height={view.h} class="map-view" />
          </svg>
        {:else}
          <div class="node-list">
            {#each nodeGroups as g (g.type)}
              <div class="group">{g.label}</div>
              {#each g.nodes as n (n.id)}
                <button class="node-link" class:sel={selected?.kind === 'node' && selected.id === n.id} onclick={() => focusNode(n)}>
                  {#if issues.nodes[n.id]}<span class="warn-mark small-mark">!</span>{/if}
                  {n.name || n.id}
                  <span class="muted mono">{n.id}</span>
                </button>
              {/each}
            {/each}
          </div>
        {/if}
      </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .graph-page {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    min-height: 0;
  }
  .head {
    gap: 8px;
  }
  .layout {
    flex: 1;
    min-height: 460px;
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr) 270px;
    gap: 10px;
  }
  /* narrow windows: configuration below the canvas */
  @media (max-width: 1100px) {
    .layout {
      grid-template-columns: 130px minmax(0, 1fr);
      grid-template-rows: minmax(420px, 1fr) auto;
    }
    .side {
      grid-column: 1 / -1;
    }
  }
  .palette {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: auto;
  }
  .group {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-3);
    margin-top: 6px;
  }
  .add {
    text-align: left;
  }
  .canvas {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background-color: var(--bg);
    background-image: radial-gradient(var(--bg-3) 1px, transparent 1px);
    background-size: 20px 20px;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .world {
    position: absolute;
    inset: 0;
  }
  .edges {
    position: absolute;
    left: -4000px;
    top: -4000px;
    pointer-events: none;
  }
  .edge {
    fill: none;
    stroke: var(--fg-3);
    stroke-width: 2;
    pointer-events: none;
  }
  .edge.err {
    stroke: var(--bad);
    stroke-dasharray: 5 4;
  }
  .edge.child {
    stroke: var(--accent);
    stroke-dasharray: 2 4;
  }
  .edge.draft {
    stroke: var(--accent);
  }
  .edge.sel {
    stroke: var(--accent);
    stroke-width: 3;
  }
  .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 18;
    cursor: pointer;
    pointer-events: stroke;
  }
  .node {
    position: absolute;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    cursor: default;
  }
  .node.ghost {
    position: fixed;
    z-index: 50;
    pointer-events: none;
    opacity: 0.85;
    border-color: var(--accent);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  }
  .node.ghost.off {
    opacity: 0.45;
  }
  .node.ghost .node-head {
    border-bottom: 0;
  }
  .node.sel {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .node.ok {
    border-color: var(--ok);
  }
  .node.failed {
    border-color: var(--bad);
  }
  .node.warn {
    border-color: var(--warn);
    border-style: dashed;
  }
  .warn-mark {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--warn);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .issues {
    margin: 0;
    padding: 6px 8px 6px 22px;
    background: var(--warn-bg);
    color: var(--warn);
    border-radius: 6px;
    font-size: 12px;
  }
  .warn-text {
    margin: 0;
    color: var(--warn);
    font-size: 12.5px;
  }
  .node-head {
    position: relative;
    height: 30px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    cursor: move;
  }
  .node-title {
    font-weight: 600;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-type {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--fg-3);
    white-space: nowrap;
  }
  .loop-row {
    position: absolute;
    left: 10px;
    right: 10px;
    height: 22px;
    line-height: 22px;
    font-size: 11px;
    color: var(--fg-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .out-row {
    position: absolute;
    right: 0;
    height: 22px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .out-label {
    font-size: 11px;
    color: var(--fg-2);
  }
  .out-label.err {
    color: var(--bad);
  }
  .out-label.taken {
    font-weight: 700;
  }
  .port {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid var(--fg-3);
  }
  .port.in {
    position: absolute;
    left: -7px;
    top: 8px;
  }
  .port.out {
    margin-right: -7px;
    cursor: crosshair;
  }
  .port.out.err {
    border-color: var(--bad);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: auto;
    font-size: 13px;
  }
  .navigator {
    flex: none;
    height: 210px;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg);
  }
  .nav-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }
  .nav-tabs button {
    flex: 1;
    border: none;
    border-radius: 0;
    background: var(--bg-1);
    font-size: 12px;
    padding: 4px;
  }
  .nav-tabs button.on {
    background: var(--bg);
    font-weight: 600;
  }
  .minimap {
    flex: 1;
    width: 100%;
    cursor: pointer;
    touch-action: none;
  }
  .map-edge {
    stroke: var(--fg-3);
    stroke-width: 6;
  }
  .map-node {
    fill: var(--bg-3);
    stroke: var(--border);
    stroke-width: 4;
  }
  .map-node.ok {
    fill: var(--ok-bg);
    stroke: var(--ok);
  }
  .map-node.failed {
    fill: var(--bad-bg);
    stroke: var(--bad);
  }
  .map-node.warn {
    stroke: var(--warn);
  }
  .map-node.sel {
    stroke: var(--accent);
    stroke-width: 10;
  }
  .map-view {
    fill: color-mix(in srgb, var(--accent) 12%, transparent);
    stroke: var(--accent);
    stroke-width: 8;
    cursor: move;
  }
  .node-list {
    flex: 1;
    overflow: auto;
    padding: 4px 6px;
    font-size: 12.5px;
  }
  .node-link {
    display: flex;
    gap: 6px;
    align-items: center;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .node-link:hover,
  .node-link.sel {
    background: var(--bg-2);
  }
  .node-link .mono {
    margin-left: auto;
    font-size: 11px;
  }
  .params {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .param {
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-2);
  }
  .small-mark {
    width: 14px;
    height: 14px;
    font-size: 10px;
  }
  .panel label:not(.check) {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .panel label > span {
    font-size: 12px;
    color: var(--fg-2);
  }
  .case {
    display: flex;
    gap: 4px;
  }
  .case input:first-child {
    width: 80px;
  }
  .step {
    border-top: 1px solid var(--border);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  pre {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    font-size: 11.5px;
    background: var(--bg-2);
    border-radius: 6px;
    padding: 6px 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .err-text {
    color: var(--bad);
  }
  .danger-outline {
    color: var(--bad);
    align-self: flex-start;
  }
</style>

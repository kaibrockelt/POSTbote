<script>
  import CodeArea from './CodeArea.svelte';
  let { scripts = $bindable(), preLabel = 'Pre-request', postLabel = 'Post-response', context = 'request' } = $props();
  let help = $state(false);
</script>

<div class="scripts">
  <div class="row between">
    <strong>{preLabel}</strong>
    <button class="link" onclick={() => (help = !help)}>{help ? 'Hide' : 'Show'} script API</button>
  </div>
  {#if help}
    <div class="help mono">
      <div><b>req</b> .method .url .body .headers .params · setHeader(k,v) removeHeader(k) setParam(k,v) json() setJson(obj)</div>
      <div><b>res</b> .status .headers .body .timeMs · json() text() header(k)</div>
      <div><b>test</b>(name, fn) · <b>expect</b>(v).toBe/toEqual/toContain/toMatch/toBeGreaterThan/toHaveProperty/… · .not</div>
      <div><b>env</b>.get/set/unset/all — set() is saved to the active environment file</div>
      <div><b>vars</b>.get/set/has/unset/all/resolve/interpolate — runtime values shared by a run</div>
      <div><b>fs</b>.read/readJson/write/writeJson/append/exists/remove/list — files of this collection</div>
      <div><b>csv</b>.parse(text, {'{header, delimiter}'}) · csv.stringify(rows)</div>
      <div><b>util</b>.uuid/now/isoNow/randomInt/base64Encode/base64Decode/hash(alg,s)/hmac(alg,key,msg)/sleep(ms)</div>
      <div><b>postbote</b>.sendRequest({'{method, url, headers, body}'}) → res</div>
      {#if context === 'workflow'}
        <div><b>wf</b>.rows (set in the pre-run script) .row .iteration .results .last · goto(step) stop(reason) skipIteration()</div>
      {/if}
      <div><b>console</b>.log/info/warn/error</div>
    </div>
  {/if}
  <CodeArea bind:value={scripts.pre} rows={7} placeholder={context === 'workflow' ? "// e.g. wf.rows = csv.parse(fs.read('data/users.csv'))" : "// e.g. req.setHeader('X-Request-Id', util.uuid())"} />
  <strong>{postLabel}</strong>
  <CodeArea bind:value={scripts.post} rows={9} placeholder={context === 'workflow' ? "// e.g. fs.write('out/report.json', JSON.stringify(wf.results, null, 2))" : "// e.g. test('ok', () => expect(res.status).toBe(200))"} />
</div>

<style>
  .scripts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .help {
    font-size: 11.5px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: var(--fg-2);
  }
  .help b {
    color: var(--accent);
  }
</style>

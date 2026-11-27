const REPOSITORY = '1159312243h-gif/ogf-huayu_map';
const WORKFLOW = 'data-refresh-watchdog.yml';
const API = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const COOLDOWN = 15 * 60 * 1000;
const JSON_HEADERS = {'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store'};
export const SCHEMA = `CREATE TABLE IF NOT EXISTS refresh_clock (
  id INTEGER PRIMARY KEY CHECK(id = 1), lease_until INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER, scheduled_at INTEGER, outcome TEXT, run_id INTEGER, dispatched_at INTEGER
)`;

export function inspectLatest(packet, now) {
  if (!Number.isSafeInteger(packet?.total_count) || packet.total_count < 0 || !Array.isArray(packet.workflow_runs)
    || packet.workflow_runs.length !== (packet.total_count > 0 ? 1 : 0)) throw Error('incomplete-github-history');
  const run = packet.workflow_runs[0];
  if (!run) return {action:'dispatch',reason:'no-previous-check'};
  const created = Date.parse(run.created_at);
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || run.head_branch !== 'main'
    || !['completed',...ACTIVE].includes(run.status) || !Number.isFinite(created) || created > now)
    throw Error('invalid-github-history');
  if (ACTIVE.has(run.status)) return {action:'wait',reason:'check-already-active',runId:run.id};
  if (now - created < COOLDOWN) return {action:'wait',reason:'recent-check',runId:run.id};
  return {action:'dispatch',reason:'check-due'};
}

export async function tick(environment, {now=Date.now(), scheduledAt=now, fetcher=fetch,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if (!environment.DB || typeof environment.GITHUB_DISPATCH_TOKEN !== 'string' || !environment.GITHUB_DISPATCH_TOKEN)
    throw Error('scheduler-not-configured');
  const lock = await environment.DB.prepare(`INSERT INTO refresh_clock (id,lease_until) VALUES (1,?)
    ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until WHERE refresh_clock.lease_until<=?
    RETURNING id,dispatched_at`).bind(now+120000,now).first();
  if (!lock) return {status:'waiting',reason:'clock-lease-active'};
  let decision, outcome='scheduler-failed', lastDispatch=null;
  try {
    if(lock.dispatched_at && now-lock.dispatched_at<COOLDOWN){outcome='local-dispatch-cooldown';return {status:outcome};}
    async function api(method,route,body) {
      const response=await fetcher(API+route,{method,redirect:'manual',signal:AbortSignal.timeout(30000),
        headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+environment.GITHUB_DISPATCH_TOKEN,
          'User-Agent':'Huayu-independent-update-clock','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
        ...(body?{body:JSON.stringify(body)}:{})});
      if (!response.ok) {await response.body?.cancel();throw Error('github-http-'+response.status);}
      if(method==='POST') {if(response.status!==204)throw Error('unexpected-dispatch-acknowledgement');return;}
      return response.json();
    }
    let packet;
    for(let attempt=0;attempt<3;attempt++) {
      packet=await api('GET','/runs?branch=main&per_page=1');
      try {decision=inspectLatest(packet,now);break;} catch(error) {
        if(error.message!=='incomplete-github-history'||attempt===2)throw error;
        await wait(1000*(attempt+1));
      }
    }
    if(decision.action==='dispatch') {
      // A second read catches a GitHub clock or manual check starting meanwhile.
      decision=inspectLatest(await api('GET','/runs?branch=main&per_page=1'),now);
      if(decision.action==='dispatch') {await api('POST','/dispatches',{ref:'main'});lastDispatch=now;outcome='dispatch-accepted';}
    }
    if(!lastDispatch)outcome=decision.reason;
    return {status:outcome,checkedAt:new Date(now).toISOString(),...decision};
  } catch(error) {
    // Only our finite error codes are persisted; never store provider bodies or credentials.
    outcome=/^(github-http-\d{3}|incomplete-github-history|invalid-github-history|unexpected-dispatch-acknowledgement)$/.test(error.message)
      ? error.message : 'scheduler-request-failed';
    throw Error(outcome);
  } finally {
    await environment.DB.prepare(`UPDATE refresh_clock SET lease_until=0,checked_at=?,scheduled_at=?,
      outcome=?,run_id=?,dispatched_at=COALESCE(?,dispatched_at) WHERE id=1 AND lease_until=?`)
      .bind(now,scheduledAt,outcome,decision?.runId||null,lastDispatch,now+120000).run();
  }
}

export function createWorker(fetcher=fetch) {return {
  async scheduled(controller,environment,context) {
    context.waitUntil(tick(environment,{scheduledAt:controller.scheduledTime,fetcher}));
  },
  async fetch(request,environment) {
    const url=new URL(request.url);
    if(url.pathname!=='/health')return new Response('Not found',{status:404});
    if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers:{Allow:'GET'}});
    if(!environment.DB || !environment.GITHUB_DISPATCH_TOKEN)return Response.json({status:'unconfigured'},{status:503,headers:JSON_HEADERS});
    try {
      const row=await environment.DB.prepare('SELECT checked_at,scheduled_at,outcome,run_id,dispatched_at FROM refresh_clock WHERE id=1').first();
      const iso=value=>value?new Date(value).toISOString():null;
      return Response.json({status:row?.checked_at?'checked':'awaiting-first-cron',
        repository:REPOSITORY,workflow:WORKFLOW,checkedAt:iso(row?.checked_at),scheduledAt:iso(row?.scheduled_at),
        outcome:row?.outcome||null,runId:row?.run_id||null,lastDispatchedAt:iso(row?.dispatched_at),
        source:'cloudflare-cron',intervalMinutes:5,dispatchCooldownMinutes:15},{headers:JSON_HEADERS});
    } catch {return Response.json({status:'clock-state-unavailable'},{status:503,headers:JSON_HEADERS});}
  }
};}
export default createWorker();

import { callRunner, type RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { BROWSER_EVIDENCE_TIMEOUT_MS, listBrowserCalls, readBrowserState, refreshBrowserEvidence, sweepBrowserEvidence, type EvidenceFetch } from "./browser-evidence.js";
import type { BrowserEvidenceTarget } from "./browser-evidence-contract.js";
let db: RealSchemaD1;
const target: BrowserEvidenceTarget = { userId: "u1", instanceId: "i1", subjectKind: "local_browser_run", subjectId: "run-1" };
const env = () => ({ DB: db.DB });
const call = (seq: number, callId = `c${seq}`) => ({ seq, callId, subject: { kind: target.subjectKind, id: target.subjectId }, tool: "browser_click", args: { element: "Apply", text: "PRIVATE", textLength: 7, url: "https://jobs.test/form?secret=PRIVATE" }, startedAt: "2026-11-04T00:00:00Z", durationMs: 12, outcome: "tool_error", internal: false, errorHead: "button is detached" });
const state = { subject: { kind: target.subjectKind, id: target.subjectId }, epoch: "e1", capturedAt: "2026-11-04T00:00:00Z", current: false, availability: "available", state: { nativeActivePageId: "p2", mcpSelectedPageId: "p1", selection: "different", tabs: [{ pageId: "p2", index: 1, url: "https://jobs.test/form?secret=PRIVATE", nativeActive: true, mcpSelected: false }], tabCount: 2, tabsTruncated: false, pendingChooser: { pageId: "p2", chooserId: "chooser" }, dialog: { status: "unknown" } } };
const fetcher = (calls: unknown[] = [call(1)], epoch: string | undefined = "e1"): EvidenceFetch => async path => Response.json(path === "/browser-state" ? state : { calls, epoch, lastSeq: calls.length, dropped: 0, hasMore: false });
beforeEach(() => {
 db = realSchemaD1();
 db.exec(`INSERT INTO users(id,github_login) VALUES('u1','u1'),('u2','u2'); INSERT INTO agents(id,owner_id,slug,name) VALUES('a1','u1','evidence','Evidence'); INSERT INTO agent_instances(id,agent_id,user_id,status,config) VALUES('i1','a1','u1','active','{}'); INSERT INTO local_browser_runs(id,instance_id,user_id,request_id,objective,status,policy,created_at,updated_at) VALUES('run-1','i1','u1','r1','test','completed','{}',1,1),('run-2','i1','u1','r2','other','completed','{}',1,1)`);
});
afterEach(() => db.close());
it("retains ended-run errors and pages stable insertion order without raw input values", async () => {
 await refreshBrowserEvidence(env(), target, fetcher([call(1),call(2),call(3)]));
 const first = await listBrowserCalls(env(),target,undefined,2);
 expect(first.calls.map(c=>c.callId)).toEqual(["c1","c2"]); expect(first.hasMore).toBe(true);
 expect(first.calls[0]).toMatchObject({ errorHead:"button is detached",args:{element:"Apply",textLength:7,url:"https://jobs.test/form"} });
 expect(JSON.stringify(first)).not.toContain("PRIVATE");
 expect((await listBrowserCalls(env(),target,first.nextCursor!,2)).calls.map(c=>c.callId)).toEqual(["c3"]);
 await refreshBrowserEvidence(env(),target,fetcher([call(1),call(2),call(3)]));
 expect((await listBrowserCalls(env(),target)).calls).toHaveLength(3);
});
it("rejects cross-owner, instance, subject and cursor before contacting a runner",async()=>{
 let reads=0; const f:EvidenceFetch=async()=>{reads++;return Response.json({});};
 for(const t of [{...target,userId:"u2"},{...target,instanceId:"other"},{...target,subjectId:"missing"}]) await expect(refreshBrowserEvidence(env(),t,f)).rejects.toThrow("not found");
 expect(reads).toBe(0); await refreshBrowserEvidence(env(),target,fetcher([call(1),call(2)]));
 const page=await listBrowserCalls(env(),target,undefined,1);
 await expect(listBrowserCalls(env(),{...target,subjectId:"run-2"},page.nextCursor!)).rejects.toThrow("cursor");
});
it("reports old209 relay refusal and unsupported state, preserving retained errors",async()=>{
 await refreshBrowserEvidence(env(),target,fetcher());
 await refreshBrowserEvidence(env(),target,async path=>new Response(null,{status:path==="/browser-calls"?403:404}));
 const out=await listBrowserCalls(env(),target);expect(out.coverage.status).toBe("refused");expect(out.calls).toHaveLength(1);
 const snapshot=await readBrowserState(env(),target,true);expect(snapshot).toMatchObject({availability:"unsupported",freshness:"retained",snapshot:{current:false,state:{selection:"different"}}});
});
it("follows native pages, tracks drops and restart epochs without losing old calls",async()=>{
 const cursors:number[]=[];
 await refreshBrowserEvidence(env(),target,async(path,body)=>{if(path==="/browser-state")return Response.json(state);cursors.push(Number(body.afterSeq));return Response.json({epoch:"e1",calls:[call(Number(body.afterSeq)+1)],lastSeq:Number(body.afterSeq)+1,dropped:3,hasMore:body.afterSeq===0});});
 expect(cursors).toEqual([0,1]);
 await refreshBrowserEvidence(env(),target,fetcher([call(1,"new-process")],"e2"));
 const out=await listBrowserCalls(env(),target);expect(out.calls).toHaveLength(3);expect(out.coverage).toMatchObject({restartObserved:true,epoch:"e2",priorEpochDropped:3});
});
it("marks legacy epoch uncertainty, malformed records and failed refreshes honestly",async()=>{
 await refreshBrowserEvidence(env(),target,fetcher([call(1),{...call(2),subject:{kind:"local_browser_run",id:"someone-else"}}],undefined));
 // Deliberately omit epoch, as CLI209 does.
 await refreshBrowserEvidence(env(),target,async path=>path==="/browser-state"?new Response(null,{status:404}):Response.json({calls:[call(1)],lastSeq:1,dropped:0}));
 expect((await listBrowserCalls(env(),target)).coverage).toMatchObject({legacyEpochUnknown:true,status:"partial",invalidRecords:1});
 await refreshBrowserEvidence(env(),target,async()=>{throw Error("offline");});
 expect((await listBrowserCalls(env(),target))).toMatchObject({calls:[{callId:"c1"}],coverage:{status:"unavailable"}});
});
it("keeps cached state historical and sweeps retention",async()=>{
 await refreshBrowserEvidence(env(),target,fetcher(),1000);
 expect(await readBrowserState(env(),target,true)).toMatchObject({freshness:"retained",snapshot:{current:false,state:{pendingChooser:{chooserId:"chooser"}}}});
 await sweepBrowserEvidence(env(),1000+31*86400000);
 expect((await listBrowserCalls(env(),target)).calls).toEqual([]);expect((await readBrowserState(env(),target)).availability).toBe("not_collected");
});

it("ingests generic action evidence with a bounded read deadline and never replays a failed action",async()=>{
 db.exec(`INSERT INTO instance_runtime_tasks(id,instance_id,user_id,type,status,payload,created_at,updated_at) VALUES('task-1','i1','u1','browser.task','failed','{}','2026-11-04','2026-11-04')`);
 const sent:Array<{path:string,timeoutMs?:number}>=[];
 const bindings:Pick<Env,"DB">={DB:db.DB};const runtimeEnv=bindings as Env;
 runtimeEnv.RELAY={idFromName:()=>"relay",get:()=>({fetch:async(request:Request)=>{const body=await request.json() as {path:string,timeoutMs?:number};sent.push(body);if(body.path==="/browser/act") return new Response("original action failure",{status:500});return new Response("not available",{status:403});}})} as unknown as Env["RELAY"];
 const conn:RunnerConn={env:runtimeEnv,instanceId:"i1",userId:"u1",relayName:"i1",endpointUrl:"http://unused",token:"token"};
 await expect(callRunner(conn,"/browser/act",{taskId:"task-1",action:{type:"click",target:"Apply"}})).rejects.toThrow("original action failure");
 expect(sent.map(s=>s.path)).toEqual(["/browser/act","/browser-calls","/browser-state"]);
 expect(sent.filter(s=>s.path!=="/browser/act").every(s=>s.timeoutMs===BROWSER_EVIDENCE_TIMEOUT_MS)).toBe(true);
 expect((await listBrowserCalls(env(),{...target,subjectKind:"runtime_task",subjectId:"task-1"})).coverage.status).toBe("refused");
});

it.each([200,300])("a slow refresh started at %i cannot overwrite a newer or same-ms receipt",async(oldStart)=>{
 await refreshBrowserEvidence(env(),target,fetcher(),100);
 let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const old=refreshBrowserEvidence(env(),target,async(path,body)=>{if(path==="/browser-calls"){entered();await blocked;}return fetcher()(path,body);},oldStart);
 await waiting;
 await refreshBrowserEvidence(env(),target,async(path,body)=>path==="/browser-state"?Response.json({...state,epoch:"e2",capturedAt:"2026-11-04T00:01:00Z"}):fetcher([call(1,"new")],"e2")(path,body),300);
 unblock();await old;
 expect((await listBrowserCalls(env(),target)).coverage).toMatchObject({epoch:"e2",restartObserved:true});
 expect(await readBrowserState(env(),target)).toMatchObject({capturedAt:"2026-11-04T00:01:00Z",snapshot:{epoch:"e2"}});
});
it("failed overlapping refresh preserves the state another read just captured",async()=>{
 await refreshBrowserEvidence(env(),target,fetcher(),100);
 let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const unavailable=refreshBrowserEvidence(env(),target,async path=>{if(path==="/browser-calls"){entered();await blocked;}return new Response(null,{status:503});},300);
 await waiting;
 await refreshBrowserEvidence(env(),target,async(path,body)=>path==="/browser-state"?Response.json({...state,capturedAt:"2026-11-04T00:02:00Z"}):fetcher()(path,body),200);
 unblock();await unavailable;
 expect(await readBrowserState(env(),target,true)).toMatchObject({availability:"unavailable",freshness:"retained",capturedAt:"2026-11-04T00:02:00Z"});
});

it("sanitizes embedded credential URLs before persistence and when reading legacy retained evidence", async () => {
 const sensitive = "Loading https://username:SYNTHETIC_PASSWORD@jobs.test/apply?seek-token=SYNTHETIC_TOKEN_PREFIX…#SECRET";
 const observed = { ...state, state: { ...state.state, tabs: [{ ...state.state.tabs[0], title: sensitive }] } };
 const record = { ...call(1), args: { element: sensitive, target: sensitive }, errorHead: sensitive, browserState: observed.state };
 await refreshBrowserEvidence(env(), target, async path => Response.json(path === "/browser-state" ? observed : { calls: [record], epoch: "e1", lastSeq: 1, dropped: 0, hasMore: false }));
 const storedCall = await db.DB.prepare("SELECT record FROM browser_run_calls WHERE call_id='c1'").first<{record:string}>();
 const storedState = await db.DB.prepare("SELECT state FROM browser_run_evidence WHERE subject_id='run-1'").first<{state:string}>();
 for (const retained of [storedCall?.record, storedState?.state]) {
  expect(retained).toContain("Loading https://jobs.test/apply");
  expect(retained).not.toMatch(/SYNTHETIC_|seek-token|username/);
 }
 // Simulate evidence retained by the previously deployed writer. Reads must be safe even offline.
 await db.DB.prepare("UPDATE browser_run_calls SET record=?1 WHERE call_id='c1'").bind(JSON.stringify(record)).run();
 await db.DB.prepare("UPDATE browser_run_evidence SET state=?1 WHERE subject_id='run-1'").bind(JSON.stringify(observed)).run();
 const calls = await listBrowserCalls(env(), target);
 const snapshot = await readBrowserState(env(), target);
 for (const result of [calls, snapshot]) expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_|seek-token|username/);
 expect(calls.calls[0]).toMatchObject({ args: { element: "Loading https://jobs.test/apply", target: "Loading https://jobs.test/apply" }, errorHead: "Loading https://jobs.test/apply", browserState: { tabs: [{ title: "Loading https://jobs.test/apply" }] } });
 expect(snapshot.snapshot).toMatchObject({ state: { tabs: [{ title: "Loading https://jobs.test/apply" }] } });
});

it("retains typed native timeout diagnosis through durable ingestion and sanitized offline reads", async () => {
 const secretUrl = "https://person:PRIVATE_PASSWORD@jobs.test/apply?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT";
 const toolDiagnostic = { kind: "request_deadline", phase: "native_response", tool: "browser_file_upload", execution: "pending", recoverable: false, message: `Waiting on ${secretUrl}`, originalError: `Request timed out: ${secretUrl}`, elapsedMs: 60_001, machine: { load1: 8, loadPerCpu: 1, cpus: 8, freeMemoryBytes: 1024, totalMemoryBytes: 8192, secret: "PRIVATE" }, rawArguments: { password: "PRIVATE" } };
 const record = { ...call(1), toolDiagnostic };
 await refreshBrowserEvidence(env(), target, fetcher([record]));
 const stored = await db.DB.prepare("SELECT record FROM browser_run_calls WHERE call_id='c1'").first<{record:string}>();
 expect(stored?.record).toContain('"execution":"pending"');
 expect(stored?.record).not.toMatch(/PRIVATE|rawArguments|"secret"/);
 const received = await listBrowserCalls(env(), target);
 expect(received.calls[0]?.toolDiagnostic).toEqual({ kind: "request_deadline", phase: "native_response", tool: "browser_file_upload", execution: "pending", recoverable: false, message: "Waiting on https://jobs.test/apply", originalError: "Request timed out: https://jobs.test/apply", elapsedMs: 60_001, machine: { load1: 8, loadPerCpu: 1, cpus: 8, freeMemoryBytes: 1024, totalMemoryBytes: 8192 } });
 // An older writer may have persisted unchecked extras; reads close the same boundary offline.
 await db.DB.prepare("UPDATE browser_run_calls SET record=?1 WHERE call_id='c1'").bind(JSON.stringify(record)).run();
 expect(JSON.stringify(await listBrowserCalls(env(), target))).not.toMatch(/PRIVATE|rawArguments/);
 await refreshBrowserEvidence(env(), target, fetcher([{ ...call(2), toolDiagnostic: { ...toolDiagnostic, execution: "cancelled" } }]));
 const malformed = (await listBrowserCalls(env(), target)).calls.find(item => item.callId === "c2");
 expect(malformed).toBeDefined();
 expect(malformed).not.toHaveProperty("toolDiagnostic");
});

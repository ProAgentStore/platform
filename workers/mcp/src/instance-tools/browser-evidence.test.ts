import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerBrowserEvidenceTools } from "./browser-evidence.js";
type Result={content:Array<{type:string,text?:string,data?:string,mimeType?:string}>};
function fixture(fetcher:(url:string,init?:RequestInit)=>Promise<Response>,authenticated=true){
 vi.stubGlobal("fetch",fetcher);
 const handlers=new Map<string,{schema:z.ZodObject<z.ZodRawShape>,handler:(args:Record<string,unknown>)=>Promise<Result>}>();
 const env={API_BASE:"https://api.test"};
 registerBrowserEvidenceTools({tool:(name:string,_description:string,schema:z.ZodRawShape,handler:(args:Record<string,unknown>)=>Promise<Result>)=>handlers.set(name,{schema:z.object(schema),handler})} as never,{env,tokenFor:()=>authenticated?"session":undefined,safetyFor:()=>({env,scopes:["read"]}),groups:new Set()});
 return async(name:string,args:Record<string,unknown>)=>{const tool=handlers.get(name)!;return tool.handler(tool.schema.parse(args));};
}
afterEach(()=>vi.unstubAllGlobals());
it("uses owner-scoped GET pagination with no browser actions",async()=>{
 const calls:Array<{url:string,method:string}>=[];const invoke=fixture(async(url,init)=>{calls.push({url:String(url),method:init?.method??"GET"});return Response.json({coverage:{status:"refused"}});});
 const result=await invoke("browser_run_calls",{instance_id:"i/1",subject_kind:"local_apply_run",subject_id:"run/1",cursor:"42",refresh:false,limit:2});
 expect(calls).toEqual([{url:"https://api.test/v1/instances/i%2F1/browser-runs/calls?subject_kind=local_apply_run&subject_id=run%2F1&limit=2&cursor=42&refresh=false",method:"GET"}]);
 expect(result.content[0].text).toContain('"refused"');
});
it("returns actual authenticated pixels as image content after metadata authorization",async()=>{
 const requests:Array<{url:string,auth:string|null}>=[];const invoke=fixture(async(url,init)=>{requests.push({url:String(url),auth:new Headers(init?.headers).get("Authorization")});return String(url).includes("metadata=true")?Response.json({id:"frame",subjectId:"run-1"}):new Response(new Uint8Array([255,216,255]),{headers:{"Content-Type":"image/jpeg"}});});
 const result=await invoke("browser_run_screenshot",{instance_id:"i1",artifact_id:"frame"});
 expect(result.content).toEqual([{type:"text",text:'{"id":"frame","subjectId":"run-1"}'},{type:"image",mimeType:"image/jpeg",data:"/9j/"}]);
 expect(requests).toHaveLength(2);expect(requests.every(r=>r.auth==="Bearer session")).toBe(true);
});
it("does not fetch pixels on denied metadata and reports missing image without fabrication",async()=>{
 const spy=vi.fn(async()=>Response.json({error:"not found"},{status:404}));const invoke=fixture(spy);
 expect((await invoke("browser_run_screenshot",{instance_id:"i1",artifact_id:"foreign"})).content[0].text).toContain("not found");expect(spy).toHaveBeenCalledTimes(1);
});
it("requires authentication before any evidence fetch",async()=>{
 const spy=vi.fn(async()=>Response.json({}));const invoke=fixture(spy,false);await invoke("browser_run_state",{instance_id:"i1",subject_kind:"runtime_task",subject_id:"t1"});expect(spy).not.toHaveBeenCalled();
});
it("reports an expired image after successful metadata without inventing pixels",async()=>{
 const invoke=fixture(async url=>String(url).includes("metadata=true")?Response.json({id:"frame"}):new Response(null,{status:404}));
 const result=await invoke("browser_run_screenshot",{instance_id:"i1",artifact_id:"frame"});expect(result.content).toEqual([{type:"text",text:"Error: screenshot unavailable (API 404)."}]);
});
it("refuses non-image bytes and coercively parses numeric pagination",async()=>{
 const invoke=fixture(async url=>String(url).includes("metadata=true")?Response.json({id:"frame"}):new Response("<html>not image</html>",{headers:{"Content-Type":"text/html"}}));
 expect((await invoke("browser_run_screenshot",{instance_id:"i1",artifact_id:"frame"})).content[0].text).toContain("not an image");
 await invoke("browser_run_calls",{instance_id:"i1",subject_kind:"runtime_task",subject_id:"task1",limit:"2"});
});
it("shrinks oversized call pages without a second native refresh or skipping the cursor",async()=>{
 const urls:string[]=[];const invoke=fixture(async url=>{urls.push(String(url));const limit=Number(new URL(String(url)).searchParams.get("limit"));return Response.json({calls:Array.from({length:limit},(_,i)=>({seq:i+1,browserState:{tabs:[{title:"x".repeat(10000)}]}})),hasMore:true,nextCursor:String(limit)});});
 const result=await invoke("browser_run_calls",{instance_id:"i1",subject_kind:"runtime_task",subject_id:"task1",limit:25});
 const parsed=JSON.parse(result.content[0].text!);expect(parsed.calls).toHaveLength(3);expect(parsed.nextCursor).toBe("3");
 expect(urls.map(url=>new URL(url).searchParams.get("limit"))).toEqual(["25","12","6","3"]);
 expect(urls.slice(1).every(url=>new URL(url).searchParams.get("refresh")==="false")).toBe(true);
});

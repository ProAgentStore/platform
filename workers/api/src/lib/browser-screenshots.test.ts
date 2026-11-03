import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";
import { browserScreenshotSettings, parseBrowserScreenshots, readBrowserScreenshots, screenshotBlurRunnerProblem, withBrowserCaptureSettings, withTaskScreenshotSettings, writeBrowserScreenshots } from "./browser-screenshots.js";
import { browserSettingsForDispatch } from "./browser-settings-dispatch.js";

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
 d1 = realSchemaD1(); env = { DB: d1.DB } as Env;
 d1.exec(`INSERT INTO users(id,github_login) VALUES ('u','u'); INSERT INTO agents(id,owner_id,slug,name,config) VALUES ('a','u','a','A','{}'); INSERT INTO agent_instances(id,agent_id,user_id,status,config) VALUES ('i','a','u','active','{}')`);
});
afterEach(() => d1.close());

describe("owner screenshot policy #1433", () => {
 it("defaults malformed or absent values to blurring and accepts only independent booleans", () => {
  for (const value of [undefined,null,[],false,{blurFormFields:"false"},{enabled:0}]) expect(readBrowserScreenshots({browserScreenshots:value})).toEqual({enabled:true,blurFormFields:true});
  expect(parseBrowserScreenshots({blurFormFields:false})).toEqual({blurFormFields:false});
  for (const body of [{},[],{blurFormFields:null},{enabled:"false"},{blurFormFields:false,other:true}]) expect(parseBrowserScreenshots(body)).toHaveProperty("error");
 });
 it("atomically preserves sibling controls and scopes writes to the owner", async () => {
  await writeBrowserScreenshots(env,"i","u",{blurFormFields:false});
  await writeBrowserScreenshots(env,"i","u",{enabled:false});
  await writeBrowserScreenshots(env,"i","other",{blurFormFields:true});
  expect(await browserScreenshotSettings(env,"i","u")).toEqual({enabled:false,blurFormFields:false});
  await writeBrowserScreenshots(env,"i","u",{enabled:true});
  expect(await browserScreenshotSettings(env,"i","u")).toEqual({enabled:true,blurFormFields:false});
 });
 it("overrides model input with owner policy for all generic browser tasks", async () => {
  for (const type of ["browser.open","browser.task","job.apply_agent","local_browser.research","local_browser.apply"]) {
   const body = await withTaskScreenshotSettings(env,"i","u",{type,input:{blurFormFields:false,screenshots:false,policy:{blurFormFields:false}}});
   expect(body).toMatchObject({input:{blurFormFields:true,screenshots:true}});
   if(type.startsWith("local_browser.")) expect(body).toMatchObject({input:{policy:{blurFormFields:true,screenshots:true}}});
  }
 });
 it("applies owner settings to ad-hoc actions and synthetic handoff, retains saved policy after changes", async () => {
  await writeBrowserScreenshots(env,"i","u",{enabled:false,blurFormFields:false});
  for(const path of ["/browser/act","/browser/handoff"]) expect(await withBrowserCaptureSettings(env,"i","u",path,{action:"navigate"})).toMatchObject({screenshot:false,blurFormFields:false});
  d1.exec(`INSERT INTO instance_runtime_tasks(id,instance_id,user_id,type,status,payload,created_at,updated_at) VALUES ('t','i','u','browser.open','running','{"input":{"screenshots":true,"blurFormFields":true}}','now','now')`);
  expect(await withBrowserCaptureSettings(env,"i","u","/browser/handoff",{taskId:"t"})).toMatchObject({screenshot:true,blurFormFields:true});
  expect(await withBrowserCaptureSettings(env,"i","other","/browser/handoff",{taskId:"t"})).not.toHaveProperty("screenshot");
 });
 it("checks deferred browser.open approval against its frozen policy after runner downgrade", async () => {
  d1.exec(`INSERT INTO instance_runtime_tasks(id,instance_id,user_id,type,status,payload,created_at,updated_at) VALUES ('pending','i','u','browser.open','needs_approval','{"input":{"blurFormFields":false}}','now','now')`);
  await expect(browserSettingsForDispatch(env,"i","u","/tasks/pending/approve",null,"0.4.198",{})).rejects.toThrow(/0.4.199/);
  await expect(browserSettingsForDispatch(env,"i","u","/tasks/pending/approve",null,"0.4.199",{})).resolves.toEqual({});
  d1.exec(`UPDATE instance_runtime_tasks SET payload='{"input":{"blurFormFields":false,"screenshots":false}}' WHERE id='pending'`);
  await expect(browserSettingsForDispatch(env,"i","u","/tasks/pending/approve",null,"0.4.198",{})).resolves.toEqual({});
 });

 it("requires199 only for enabled new unblurred captures, leaving existing controls usable", async () => {
  expect(screenshotBlurRunnerProblem(false,"0.4.198")).toMatch(/0.4.199/);
  expect(screenshotBlurRunnerProblem(false,undefined)).toMatch(/unknown/);
  expect(screenshotBlurRunnerProblem(false,"0.4.199")).toBeNull();
  for(const [path,body] of [["/tasks",{type:"browser.open",input:{blurFormFields:false}}],["/local-browser/run",{policy:{blurFormFields:false}}],["/browser/act",{blurFormFields:false}],["/browser/handoff",{taskId:"new",blurFormFields:false}]] as const) await expect(browserSettingsForDispatch(env,"i","u",path,null,"0.4.198",body)).rejects.toThrow(/0.4.199/);
  for(const [path,body] of [["/tasks",{type:"browser.open",input:{blurFormFields:false,screenshots:false}}],["/local-browser/run",{policy:{blurFormFields:false,screenshots:false}}],["/browser/act",{blurFormFields:false,screenshot:false}],["/browser/act",{taskId:"active",blurFormFields:false}],["/local-browser/status",{blurFormFields:false}],["/local-browser/resume",{blurFormFields:false}]] as const) await expect(browserSettingsForDispatch(env,"i","u",path,null,"0.4.198",body)).resolves.toEqual({});
 });
});

import test from "node:test";
import assert from "node:assert/strict";
import { trackJob, rememberJob, recalledJob, jobMessage } from "../src/jobTracking.js";
import { matchingDraft } from "../src/draftStore.js";
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test("polling remains serial with slow responses",async()=>{
 let active=0,max=0,calls=0;
 const stop=trackJob({interval:1,read:async()=>{active++;max=Math.max(max,active);await wait(12);active--;calls++;return {status:calls<3?"running":"succeeded"};},onJob:()=>{},onConnection:()=>{}});
 await wait(85);stop();assert.equal(max,1);assert.equal(calls,3);
});
test("network outage reconnects the existing request",async()=>{
 let calls=0,result,connections=[];
 const stop=trackJob({interval:1,maxDelay:2,read:async()=>{calls++;if(calls<3)throw Error("offline");return {id:"same-job",status:"succeeded"};},onJob:j=>result=j,onConnection:x=>connections.push(x)});
 await wait(35);stop();assert.equal(result.id,"same-job");assert.deepEqual(connections,[false,false,true]);
});
test("stop discards late response of a previous case",async()=>{
 let release,called=0;
 const stop=trackJob({read:()=>new Promise(r=>release=r),onJob:()=>called++,onConnection:()=>{}});
 stop();release({status:"succeeded"});await wait(3);assert.equal(called,0);
});
test("retry_wait and service_wait remain tracked",async()=>{
 const statuses=["service_wait","retry_wait","running","succeeded"],seen=[];
 const stop=trackJob({interval:1,read:async()=>({status:statuses.shift()}),onJob:j=>seen.push(j.status),onConnection:()=>{}});
 await wait(30);stop();assert.deepEqual(seen,["service_wait","retry_wait","running","succeeded"]);
});
test("remembered job is scoped by server user and case",()=>{
 const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k),removeItem:k=>values.delete(k)};
 rememberJob("api","u1","a","j",storage);assert.equal(recalledJob("api","u1","a",storage),"j");
 assert.equal(recalledJob("api","u2","a",storage),null);assert.equal(recalledJob("api","u1","b",storage),null);
});
test("disabled local storage does not break the workflow",()=>{
 const storage={getItem:()=>{throw Error()},setItem:()=>{throw Error()}};
 rememberJob("","u","a","j",storage);assert.equal(recalledJob("","u","a",storage),null);
});
test("draft cannot be restored to a different source or voxel grid",()=>{
 const item={id:"a",source_digest:"ct1",geometry:{shape:[2,2,2]}};
 const d={caseId:"a",sourceDigest:"ct1",geometry:JSON.stringify(item.geometry),mask:new Uint8Array(8)};
 assert.ok(matchingDraft(d,item,8));assert.ok(!matchingDraft(d,{...item,source_digest:"ct2"},8));assert.ok(!matchingDraft(d,item,9));
});
test("user messages distinguish waiting from permanent failure",()=>{
 assert.match(jobMessage({status:"service_wait"}),/giữ lại/);assert.match(jobMessage({status:"failed",error:"bad output"}),/bad output/);
 assert.match(jobMessage({status:"succeeded"}),/tham chiếu/);
});

for (const status of [404,403]) test(`HTTP ${status} stops tracking without creating a failed inference`,async()=>{
 let calls=0,unavailable=null,jobs=0,connection=[];
 const stop=trackJob({interval:1,read:async()=>{calls++;throw Object.assign(new Error("unavailable"),{status});},onUnavailable:e=>unavailable=e.status,onConnection:c=>connection.push(c),onJob:()=>jobs++});
 await wait(25);stop();assert.equal(calls,1);assert.equal(unavailable,status);assert.equal(jobs,0);assert.deepEqual(connection,[true]);
});

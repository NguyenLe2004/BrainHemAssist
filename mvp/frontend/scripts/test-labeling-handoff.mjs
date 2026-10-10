import test from "node:test";
import assert from "node:assert/strict";
import { prepareLabelingCase } from "../src/labelingHandoff.js";

const initial = { id:"case", current_revision:0, ai_job_id:"ai", source_digest:"ct", geometry:{shape:[2,2,2]} };
test("a completed Auto AI result becomes the first draft before opening the editor", async () => {
  let current={...initial}, seeds=0;
  const result=await prepareLabelingCase("case", {
    getCase:async()=>current,
    getJob:async()=>({id:"ai",status:"succeeded"}),
    seed:async(id,job,revision)=>{assert.equal(id,"case");assert.equal(job,"ai");assert.equal(revision,0);seeds++;current={...current,current_revision:1};},
  });
  assert.equal(result.current_revision,1);assert.equal(seeds,1);
});
test("opening an existing saved label never replaces it with a newer AI result", async () => {
  const current={...initial,current_revision:3};
  const result=await prepareLabelingCase("case", {getCase:async()=>current,getJob:async()=>assert.fail("AI must not replace a saved label"),seed:async()=>assert.fail("must not seed")});
  assert.equal(result.current_revision,3);
});
test("a matching unsaved local draft is preserved", async () => {
  const draft={caseId:"case",sourceDigest:"ct",geometry:JSON.stringify(initial.geometry),mask:new Uint8Array(8)};
  const result=await prepareLabelingCase("case", {getCase:async()=>initial,readDraft:async()=>draft,getJob:async()=>assert.fail("keep local edits"),seed:async()=>assert.fail("must not seed")});
  assert.equal(result.current_revision,0);
});
test("an unfinished inference does not create a label", async () => {
  const result=await prepareLabelingCase("case", {getCase:async()=>initial,getJob:async()=>({id:"ai",status:"running"}),seed:async()=>assert.fail("must not seed")});
  assert.equal(result.current_revision,0);
});
test("a concurrent label save is kept when initial seeding conflicts", async () => {
  let current={...initial};
  const result=await prepareLabelingCase("case", {getCase:async()=>current,getJob:async()=>({id:"ai",status:"succeeded"}),seed:async()=>{current={...current,current_revision:2};throw Error("revision conflict");}});
  assert.equal(result.current_revision,2);
});
test("an unsuccessful handoff remains an error instead of opening an empty editor", async () => {
  await assert.rejects(prepareLabelingCase("case", {getCase:async()=>initial,getJob:async()=>({id:"ai",status:"succeeded"}),seed:async()=>{throw Error("mask unavailable");}}), /mask unavailable/);
});

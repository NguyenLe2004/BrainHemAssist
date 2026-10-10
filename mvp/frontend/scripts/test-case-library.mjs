import assert from "node:assert/strict";
import {displayName,sortCases,hasAiResult,hasApprovedLabel,archivedAiResult} from "../src/caseLibrary.js";
const cases=[
  {id:"a",name:"Ca 10",patient_id:"10",current_revision:1,label_volume_ml:10},
  {id:"b",name:"Ca 2",patient_id:"2",current_revision:1,label_volume_ml:2},
  {id:"c",name:"Ca 1",patient_id:"1",current_revision:0,label_volume_ml:0},
];
assert.deepEqual(sortCases(cases,"volume","asc").map(c=>c.id),["b","a","c"]);
assert.deepEqual(sortCases(cases,"volume","desc").map(c=>c.id),["a","b","c"]);
assert.deepEqual(sortCases(cases,"id","asc").map(c=>c.id),["c","b","a"]);
assert.deepEqual(cases.map(c=>c.id),["a","b","c"],"Sorting must not mutate the worklist");
assert.equal(displayName("INSTANCE 2022 001 · E2E"),"INSTANCE 2022 001");
assert.equal(displayName("INSTANCE 2022 · automated 50-case E2E"),"INSTANCE 2022");
console.log("case library: 6 assertions passed");

const retained={ai_status:"archived",ai_mask_url:"/original-mask",ai_model_version:"L-old",ai_tier:"high",status:"draft",current_revision:3,latest_approved_revision:2};
assert.equal(hasAiResult(retained),true);
assert.equal(hasAiResult({ai_status:"archived"}),false);
assert.equal(hasAiResult({status:"approved"}),false);
assert.equal(hasApprovedLabel(retained),true,"New drafts must not hide previously approved labels");
assert.equal(hasApprovedLabel({status:"draft",latest_approved_revision:null}),false);
assert.equal(archivedAiResult(retained).id,null,"Retained masks must not create nonexistent job links");
assert.equal(archivedAiResult(retained).artifacts.mask,"/original-mask");
assert.equal(archivedAiResult({ai_status:"succeeded"}),null);
assert.deepEqual(sortCases([{id:"pending"},{id:"retained",...retained}],"ai","desc").map(c=>c.id),["retained","pending"]);
console.log("AI retention and approved-label assertions passed");

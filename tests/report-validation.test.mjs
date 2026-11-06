import test from 'node:test';
import assert from 'node:assert/strict';
import { reportHasFailures } from '../scripts/report-validation.mjs';

test('reports reject fatal, summary failures and individual failed cases',()=>{
  assert.equal(reportHasFailures({fatal:'startup failed'}),true);
  assert.equal(reportHasFailures({summary:{FAIL:1}}),true);
  assert.equal(reportHasFailures({cases:[{status:'PASS'},{status:'FAIL'}]}),true);
  assert.equal(reportHasFailures({cases:[{status:'PASS'}],summary:{FAIL:0}}),false);
  assert.equal(reportHasFailures({checks:['completed']}),false);
});

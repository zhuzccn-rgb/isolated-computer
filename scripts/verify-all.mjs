import { reportHasFailures } from './report-validation.mjs';
import {spawn} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='linux')throw new Error('The current full verification suite requires Linux');
const tests=[
 {name:'unit',args:['--test','tests/unit.test.mjs']},
 {name:'independent-browser-and-desktop',args:['tests/linux-integration.mjs'],report:'linux-verification.json'},
 {name:'native-accessibility',args:['tests/linux-accessibility.mjs'],report:'linux-accessibility-verification.json'},
 {name:'native-accessibility-regression',args:['tests/linux-accessibility-regression.mjs'],report:'linux-accessibility-regression.json'},
 {name:'chrome-handoff',args:['tests/chrome-handoff.mjs'],report:'linux-handoff-verification.json'},
 {name:'firefox-handoff',args:['tests/firefox-scenarios.mjs'],report:'firefox-scenarios.json'},
 {name:'firefox-native-protocol-experiment',args:['tests/firefox-protocol.mjs'],report:'firefox-native-protocol.json'},
 {name:'desktop-takeover',args:['tests/linux-takeover.mjs'],report:'linux-takeover.json'}
];
const result={date:new Date().toISOString(),platform:process.platform,tests:[],scope:'Current implemented Linux functions with local fixtures and temporary profiles/private displays. Physical OS IME, actual user desktop concurrency, Windows/macOS/Safari and arbitrary websites excluded. Firefox native protocol is an experiment, not integrated live-tab functionality.'};
for(const test of tests){
 console.log('RUN '+test.name);const start=Date.now();
 const child=spawn(process.execPath,test.args,{cwd:root,env:process.env,stdio:'inherit'});
 const exit=await new Promise(resolve=>{child.once('error',e=>resolve({error:e.message}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 const entry={name:test.name,...exit,ms:Date.now()-start,passed:exit.code===0};
 if(entry.passed&&test.report){
  const data=JSON.parse(await readFile(new URL('../artifacts/'+test.report,import.meta.url)));
  entry.checks=data.checks?.length??data.cases?.length;entry.summary=data.summary;entry.report=test.report;
  if(reportHasFailures(data)){entry.passed=false;entry.error='Report contains a failed or fatal case';}
 }
 result.tests.push(entry);
 await writeFile(new URL('../artifacts/full-verification.json',import.meta.url),JSON.stringify(result,null,2));
}
result.passed=result.tests.every(t=>t.passed);
await writeFile(new URL('../artifacts/full-verification.json',import.meta.url),JSON.stringify(result,null,2));
console.log('FULL VERIFICATION '+(result.passed?'PASS':'FAIL'));if(!result.passed)process.exitCode=1;

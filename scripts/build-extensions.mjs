import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
const original=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url)));
for(const name of ['chrome','firefox','safari']){
  const target=new URL(`../dist/extensions/${name}/`,import.meta.url);await mkdir(target,{recursive:true});await cp(new URL('../extension/',import.meta.url),target,{recursive:true});
  const manifest=structuredClone(original);
  if(name!=='chrome'){
    delete manifest.minimum_chrome_version;manifest.permissions=manifest.permissions.filter(p=>p!=='debugger');
    manifest.background={scripts:['background-loader.js'],persistent:false};
    if(name==='firefox'){
      // Firefox MV3 event pages dropped the socket after settings closed.
      // Use Firefox's supported MV2 persistent page for this local preview;
      // do not keep a visible settings tab open to prolong the connection.
      manifest.manifest_version=2;
      manifest.background.persistent=true;
      manifest.permissions.push(...manifest.host_permissions);
      delete manifest.host_permissions;
      manifest.browser_action=manifest.action;delete manifest.action;
      manifest.content_security_policy=manifest.content_security_policy.extension_pages;
      manifest.browser_specific_settings={gecko:{id:'isolated-computer@example.invalid',strict_min_version:'126.0'}};
    }
    if(name==='safari')manifest.permissions=manifest.permissions.filter(p=>p!=='notifications');
  }
  await writeFile(new URL('manifest.json',target),JSON.stringify(manifest,null,2));
}
console.log('Built Chrome, Firefox and Safari-source variants; Safari still requires Xcode conversion/signing on macOS.');

import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const mode = process.argv[2] ?? 'json';
const env = Object.fromEntries(['IC_DESKTOP_URL','IC_DESKTOP_TOKEN_FILE','IC_BROWSER_EXECUTABLE','IC_VIEWER'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
if(mode==='toml') {
  console.log('[mcp_servers.isolated-computer]');
  console.log('command = '+JSON.stringify(process.execPath));
  console.log('args = '+JSON.stringify([entry]));
  if(Object.keys(env).length){console.log('\n[mcp_servers.isolated-computer.env]');for(const [k,v]of Object.entries(env))console.log(k+' = '+JSON.stringify(v));}
} else if(mode==='json') console.log(JSON.stringify({mcpServers:{'isolated-computer':{command:process.execPath,args:[entry],...(Object.keys(env).length?{env}:{})}}},null,2));
else throw new Error('Choose json or toml');

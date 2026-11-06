import { mkdtemp,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnReady,root } from './helpers.mjs';
import { FirefoxDriver,driverAddress } from './firefox-driver.mjs';
const dir=await mkdtemp(join(tmpdir(),'ic-firefox-smoke-'));
const apps=join(dir,'apps.json');
await writeFile(apps,JSON.stringify([[process.env.IC_GECKODRIVER??'/snap/bin/geckodriver','--port','0','--allow-system-access','--log','info']]));
let session,driver;
try{
  session=await spawnReady('/usr/bin/python3',['desktop/linux_session.py','--xvfb',process.env.IC_TEST_XVFB??'Xvfb','--token-file',join(dir,'bridge.token'),'--apps-file',apps]);
  driver=new FirefoxDriver(await driverAddress(session));
  console.log('Starting system-installed Firefox');
  await driver.start();console.log(JSON.stringify({browserVersion:driver.capabilities.browserVersion,platform:driver.capabilities.platformName,pid:driver.capabilities['moz:processID']}));
  await driver.navigate('about:blank');console.log(await driver.execute('return navigator.userAgent'));
}catch(e){console.log(session?.stderr().slice(-6000));throw e;}
finally{await driver?.close();await session?.stop();}

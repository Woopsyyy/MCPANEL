import SysTray, { Conf } from 'systray2';
import * as path from 'path';
import * as fs from 'fs';
import { detectOS } from '../src/utils/helpers';
import { APP_ROOT } from '../src/config/configManager';

const SysTrayBase = SysTray as any;

class WSLSysTray extends SysTrayBase {
  constructor(conf: Conf) {
    super(conf);
  }

  async init(): Promise<void> {
    const osType = detectOS();
    console.log('Detected OS:', osType);
    if (osType === 'WSL') {
      const binName = "tray_windows_release.exe";
      const nodeModulesBin = path.join(APP_ROOT, 'node_modules', 'systray2', 'traybin', binName);
      (this as any)._binPath = nodeModulesBin;
      console.log('Forcing WSL Windows Tray Binary path to:', (this as any)._binPath);
      
      return new Promise<void>(async (resolve, reject) => {
        try {
          const child = require('child_process');
          const readline = require('readline');
          
          (this as any)._process = child.spawn((this as any)._binPath, [], {
            windowsHide: true
          });
          (this as any)._process.on('error', reject);
          (this as any)._rl = readline.createInterface({
            input: (this as any)._process.stdout
          });
          
          const internalIdMap = (this as any).internalIdMap;
          const counter = { id: 1 };
          
          const addInternalId = (item: any) => {
            const id = counter.id++;
            internalIdMap.set(id, item);
            if (item.items) {
              item.items.forEach(addInternalId);
            }
            item.__id = id;
          };
          (this as any)._conf.menu.items.forEach(addInternalId);
          
          const loadIcon = async (fileName: string) => {
            const buffer = await fs.promises.readFile(fileName);
            return buffer.toString('base64');
          };
          
          const resolveIcon = async (item: any) => {
            if (item.icon && fs.existsSync(item.icon)) {
              item.icon = await loadIcon(item.icon);
            }
            if (item.items) {
              await Promise.all(item.items.map((sub: any) => resolveIcon(sub)));
            }
          };
          await resolveIcon((this as any)._conf.menu);
          
          (this as any).onReady(() => {
            const itemTrimmer = (item: any) => ({
              title: item.title,
              tooltip: item.tooltip,
              checked: item.checked,
              enabled: item.enabled === undefined ? true : item.enabled,
              hidden: item.hidden,
              items: item.items,
              icon: item.icon,
              isTemplateIcon: item.isTemplateIcon,
              __id: item.__id
            });
            const menuTrimmer = (menu: any) => ({
              icon: menu.icon,
              title: menu.title,
              tooltip: menu.tooltip,
              items: menu.items.map(itemTrimmer),
              isTemplateIcon: menu.isTemplateIcon
            });
            
            (this as any).writeLine(JSON.stringify(menuTrimmer((this as any)._conf.menu)));
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    } else {
      return super.init();
    }
  }
}

async function test() {
  const iconFile = detectOS() === 'Windows' || detectOS() === 'WSL' 
    ? path.join(APP_ROOT, 'assets/logo.ico')
    : path.join(APP_ROOT, 'assets/logo.png');

  console.log('Icon path:', iconFile);

  const systray = new WSLSysTray({
    menu: {
      icon: iconFile,
      title: 'MCPANEL',
      tooltip: 'MCPANEL Server Manager',
      items: [
        { title: 'Open Console', tooltip: 'Restore terminal window', enabled: true },
        { title: 'Hide Console', tooltip: 'Hide terminal window', enabled: true },
        SysTray.separator,
        { title: 'Exit', tooltip: 'Stop server and exit', enabled: true }
      ]
    },
    debug: true
  });

  systray.onClick((event: any) => {
    console.log('Click event:', event.item.title);
    if (event.item.title === 'Exit') {
      systray.kill(true);
    }
  });

  console.log('Waiting for ready...');
  await systray.ready();
  console.log('Systray is ready! Click Exit in tray icon to close.');
}

test().catch(console.error);

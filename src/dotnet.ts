import proc from "child_process"
import which from "which";
import os from 'os'

export interface IDotnetSdk {
  version: string
  path: string
}

export interface IDotnetRuntime {
  name: string
  version: string
  path: string
}

export interface IDotnetInfo {
  sdkVersion: string
  sdkCommit: string
  osName: string
  osVersion: string
  osPlatform: string
  RID: string
  basePath: string
  hostVersion: string
  hostCommit: string
  sdksInstalled: IDotnetSdk[]
  runtimesInstalled: IDotnetRuntime[]
}

export class DotnetResolver {
  public static getDotnetExecutable(): Promise<string | undefined> {
    return new Promise((resolve, _) => {
      which("dotnet", (err, path) => {
        if (err) {resolve(undefined);}
        else {resolve(path);}
      });
    });
  }

  public static async getDotnetInfo(): Promise<IDotnetInfo> {
    const dotnet = await DotnetResolver.getDotnetExecutable()
    const p = proc.spawnSync(dotnet, ["--info"])
    const out = p.stdout.toString().split(os.EOL)
    let info: IDotnetInfo = {
      sdkVersion: '', sdkCommit: '',
      osName: '', osVersion: '', osPlatform: '', RID: '', basePath: '',
      hostVersion: '', hostCommit: '',
      sdksInstalled: [], runtimesInstalled: [],
    }
    const sp = (s: string, sep: string) => {
      for(var i = 0; i < s.length; ++i) {
        if(s[i] === sep) {
          return [s.substr(0, i), s.substr(i+1)]
        }
      }
      return [s]
    }
    const kv = (s: string, pat: string, f: string) => {
      let [k, v] = sp(s.trim(), ':')
      if (k === pat) {
        let data: {[k: string]: string} = {}
        data[f] = v.trim()
        info = Object.assign(info, data)
      }
    }
    const detup = (s:string) => {
      let [x, path] = sp(s, '[')
      path = path.substr(0, path.length-1)
      return {t:x.trim().split(' '), p:path}
    }
    const parse: {[index: string]: (s: string) => void} = {
      'ver': (s: string) => {
        kv(s, 'Version', 'sdkVersion');
        kv(s, 'Commit', 'sdkCommit');
      },
      'env': (s: string) => {
        kv(s, 'OS Name', 'osName');
        kv(s, 'OS Version', 'osVersion');
        kv(s, 'OS Platform', 'osPlatform');
        kv(s, 'RID', 'RID');
        kv(s, 'Base Path', 'basePath');
      },
      'host': (s: string) => {
        kv(s, 'Version', 'hostVersion');
        kv(s, 'Commit', 'hostCommit');
      },
      'sdks': (s: string) => {
        let {t:[v], p:p} = detup(s);
        info.sdksInstalled.push({ version: v, path:p })
      },
      'rt': (s: string) => {
        let {t:[n,v],p:p} = detup(s)
        info.runtimesInstalled.push({version:v, name:n, path:p})
      },
      '': (_: string) => {},
    }
    let state = ''
    for (let s of out) {
      console.log(s)
      switch (s) {
        case '.NET SDK (reflecting any global.json):':
        case '.NET Core SDK (reflecting any global.json):':
          state = 'ver';
          break;
        case 'Runtime Environment:':
          state = 'env';
          break;
        case 'Host (useful for support):':
          state = 'host';
          break;
        case '.NET SDKs installed:':
        case '.NET Core SDKs installed:':
          state = 'sdks';
          break;
        case '.NET runtimes installed:':
        case '.NET Core runtimes installed:':
          state = 'rt';
          break;
        case '':
          state = '';
          break;
        default:
          parse[state](s);
          break;
      }
    }
    return info
  }
}

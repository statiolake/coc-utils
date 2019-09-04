"use strict";

import fs = require("fs");
import os = require("os");
import path = require("path");
import {workspace} from 'coc.nvim';
import {Uri, fetch} from 'coc.nvim'
import {IncomingMessage, Agent} from 'http';
import tunnel from 'tunnel';

import { http, https } from "follow-redirects";
import { UrlWithStringQuery, parse } from "url";

export type FstArg<T> = T extends (arg1: infer U, ...args: any[]) => any ? U : any
export type SndArg<T> = T extends (arg1: any, arg2: infer U, ...args: any[]) => any ? U : any

export type HttpsOpts = FstArg<typeof https.request>
export type HttpOpts = FstArg<typeof http.request>

export function fileURLToPath(x: string) {
    return Uri.parse(x).fsPath
}

export function sleep(ms: number) {
    return new Promise((resolve, __) => setTimeout(resolve, ms))
}

export function ensurePathExists(targetPath: string) {
    // Ensure that the path exists
    try {
        fs.mkdirSync(targetPath);
    } catch (e) {
        // If the exception isn't to indicate that the folder exists already, rethrow it.
        if (e.code !== "EEXIST") {
            throw e;
        }
    }
}

export function getPipePath(pipeName: string) {
    if (os.platform() === "win32") {
        return "\\\\.\\pipe\\" + pipeName;
    } else {
        // Windows uses NamedPipes where non-Windows platforms use Unix Domain Sockets.
        // This requires connecting to the pipe file in different locations on Windows vs non-Windows.
        return path.join(os.tmpdir(), `CoreFxPipe_${pipeName}`);
    }
}

export function checkIfFileExists(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.R_OK);
        return true;
    } catch (e) {
        return false;
    }
}

export function getTimestampString() {
    const time = new Date();
    return `[${time.getHours()}:${time.getMinutes()}:${time.getSeconds()}]`;
}

export function isWindowsOS(): boolean {
    return os.platform() === "win32";
}

export async function getCurrentSelection(mode: string) {
    let doc = await workspace.document

    if (mode === "v" || mode === "V") {
        let [from,] = await doc.buffer.mark("<")
        let [to,] = await doc.buffer.mark(">")
        let result: string[] = []
        for (let i = from; i <= to; ++i) {
            result.push(doc.getline(i - 1))
        }
        return result
    }
    else if (mode === "n") {
        let line = await workspace.nvim.call('line', '.')
        return [doc.getline(line - 1)]
    }
    else if (mode === "i") {
        // TODO what to do in insert mode?
    }
    else if (mode === "t") {
        //TODO what to do in terminal mode?
    }

    return []
}



export function getAgent(endpoint: UrlWithStringQuery): Agent {
  let key = endpoint.protocol.startsWith('https') ? 'HTTPS_PROXY' : 'HTTP_PROXY'
  let env = process.env[key] || process.env[key.toLowerCase()]
  if (env) {
    let noProxy = process.env.NO_PROXY || process.env.no_proxy
    if (noProxy === '*') {
      env = null
    } else if (noProxy) {
      // canonicalize the hostname, so that 'oogle.com' won't match 'google.com'
      const hostname = endpoint.hostname.replace(/^\.*/, '.').toLowerCase()
      const port = endpoint.port || endpoint.protocol.startsWith('https') ? '443' : '80'
      const noProxyList = noProxy.split(',')

      for (let i = 0, len = noProxyList.length; i < len; i++) {
        let noProxyItem = noProxyList[i].trim().toLowerCase()

        // no_proxy can be granular at the port level, which complicates things a bit.
        if (noProxyItem.indexOf(':') > -1) {
          let noProxyItemParts = noProxyItem.split(':', 2)
          let noProxyHost = noProxyItemParts[0].replace(/^\.*/, '.')
          let noProxyPort = noProxyItemParts[1]
          if (port === noProxyPort && hostname.endsWith(noProxyHost)) {
            env = null
            break
          }
        } else {
          noProxyItem = noProxyItem.replace(/^\.*/, '.')
          if (hostname.endsWith(noProxyItem)) {
            env = null
            break
          }
        }
      }
    }
  }
  let proxy = workspace.getConfiguration('http').get<string>('proxy', '')
  if (!proxy && env) {
    proxy = env
  }
  if (proxy) {
    proxy = proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')
    let auth = proxy.includes('@') ? proxy.split('@', 2)[0] : ''
    let parts = auth.length ? proxy.slice(auth.length + 1).split(':') : proxy.split(':')
    if (parts.length > 1) {
      let agent = tunnel.httpsOverHttp({
        proxy: {
          headers: {},
          host: parts[0],
          port: parseInt(parts[1], 10),
          proxyAuth: auth
        }
      })
      return agent
    }
  } 
  return null;
}

export function httpsGet<T>(
    url: string,
    cb: (resolve: (value?: T | PromiseLike<T>) => void,
         reject: (reason?: any) => void,
         res: IncomingMessage)
        => void) {
  let endpoint = parse(url)
  return new Promise<T>((resolve, reject) => {
    let options = {
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.path,
      method: 'GET',
      agent: getAgent(endpoint)
    };
    const req = https.request(options, (res: IncomingMessage) => {
      if (res.statusCode != 200) {
        reject(new Error(`Invalid response from ${JSON.stringify(url)}: ${res.statusCode}`))
        return
      }
      cb(resolve, reject, res)
    })
    req.setHeader('user-agent', 'coc.nvim')
    req.on('error', reject)
    req.end()
  })
}

export async function httpsGetJson<T>(url: string): Promise<T> {
  let content = await fetch(url);
  if (typeof(content) === "string") {
    return JSON.parse(content);
  } else {
    return content as T;
  }
}

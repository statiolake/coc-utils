import {workspace, ExtensionContext, MsgTypes} from 'coc.nvim'
import {httpsGet, httpsGetJson, HttpsOpts, checkIfFileExists} from "./utils"
import fs = require("fs");
import path = require("path");
import {getPlatformSignature, getPlatformDetails, OperatingSystem} from './platform';
import unzip from "extract-zip";
import rimraf from "rimraf";


export interface ILanguageServerPackage {
    //  the executable of the language server, 
    //  in the downloaded and extracted package
    executable: string
    platformPath: string | RegExp
}

export interface ILanguageServerPackages {
    [platform: string]: ILanguageServerPackage
}

export type LanguageServerRepository =
    | {kind: "github", repo: string, channel: string}
    | {kind: "url-prefix", url: string}

interface IGithubAsset {
    name: string
    browser_download_url: string
}

interface IDownloadInfo {
    url: string
    version: string
    id: number
    downloadedTime: number
}

interface IGithubRelease {
    // the assets collection
    assets: IGithubAsset[]
    // the name of the release
    name: string
    // the unique id of the release
    id: number
    tag_name?: string
    prerelease?: boolean
    draft?: boolean
}

export class LanguageServerProvider {
    private extensionStoragePath: string
    private languageServerName: string
    private languageServerDirectory: string
    private languageServerZip: string
    private languageServerExe: string
    private languageServerPackage: ILanguageServerPackage

    constructor(extension: ExtensionContext, name: string, packs: ILanguageServerPackages, private repo: LanguageServerRepository) {
        const platsig = getPlatformSignature()
        this.languageServerName = name
        this.extensionStoragePath = extension.storagePath
        this.languageServerPackage = packs[platsig]

        if (!this.languageServerPackage) {throw "Platform not supported"}

        this.languageServerDirectory = path.join(this.extensionStoragePath, "server")
        this.languageServerZip = this.languageServerDirectory + ".zip"
        this.languageServerExe = path.join(this.languageServerDirectory, this.languageServerPackage.executable)
    }

    async fetchDownloadInfo(platfile: string | RegExp): Promise<IDownloadInfo> {
        if (this.repo.kind === "github") {
            let {repo: repo, channel: channel} = this.repo
            let api_url = `https://api.github.com/repos/${repo}/releases/${channel}`
            let api_result = await httpsGetJson<IGithubRelease>(api_url)
            let matched_assets = api_result.assets.filter(
              x => {
                if (typeof platfile === "string") {
                  return x.name === platfile
                } else {
                  return platfile.exec(x.name);
                }
            })
            return {
                url: matched_assets[0].browser_download_url,
                version: api_result.name,
                id: api_result.id,
                downloadedTime: Date.now()
            }
        } else if (this.repo.kind === "url-prefix") {
            return {
                url: `${this.repo.url}/${platfile}`,
                version: '',
                id: 0,
                downloadedTime: Date.now()
            }
        }
        throw new Error("unsupported repo kind.")
    }

    loadLocalDownloadInfo(): IDownloadInfo {
        let fname = path.join(this.extensionStoragePath, "downloadinfo.json")
        if (!checkIfFileExists(fname)) {
            return null
        }
        return JSON.parse(fs.readFileSync(fname, 'utf-8'))
    }

    saveLocalDownloadInfo(inf: IDownloadInfo) {
        let content = JSON.stringify(inf)
        let fname = path.join(this.extensionStoragePath, "downloadinfo.json")
        fs.writeFileSync(fname, content, 'utf-8')
    }

    public async downloadLanguageServer(): Promise<void> {

        let item = workspace.createStatusBarItem(0, {progress: true})

        try {
            if (!fs.existsSync(this.extensionStoragePath)) {
                fs.mkdirSync(this.extensionStoragePath)
            }

            item.text = `Looking for ${this.languageServerName} updates`
            item.show()

            let platfile = this.languageServerPackage.platformPath
            let downinfo = await this.fetchDownloadInfo(platfile)
            let localinfo = this.loadLocalDownloadInfo()
            if (localinfo && localinfo.id === downinfo.id && localinfo.version === downinfo.version) {
                // update localinfo timestamp and return
                localinfo.downloadedTime = Date.now()
                this.saveLocalDownloadInfo(localinfo)
                return
            }

            if (fs.existsSync(this.languageServerDirectory)) {
                rimraf.sync(this.languageServerDirectory)
            }

            fs.mkdirSync(this.languageServerDirectory)

            item.text = `Downloading ${this.languageServerName}`
            item.show()
            workspace.showMessage(`Downloading ${this.languageServerName}`, 'more')

            await httpsGet(downinfo.url, (resolve, _, res) => {
                let file = fs.createWriteStream(this.languageServerZip)
                let stream = res.pipe(file)
                stream.on('finish', resolve)
            })

            item.text = `Extracting ${this.languageServerName}`
            item.show()
            workspace.showMessage(`Extracting ${this.languageServerName}`, 'more')


            await new Promise<void>((resolve, reject) => {
                unzip(this.languageServerZip, {dir: this.languageServerDirectory}, (err: any) => {
                    if (err) reject(err)
                    else resolve()
                })
            })

            fs.unlinkSync(this.languageServerZip)
            // update timestamp
            downinfo.downloadedTime = Date.now()
            this.saveLocalDownloadInfo(downinfo)
        } finally {
            item.dispose()
        }
    }

    // returns the full path to the language server executable
    public async getLanguageServer(): Promise<string> {

        const plat = getPlatformDetails()

        if (!fs.existsSync(this.languageServerExe) || this.shouldRegularUpdate()) {
            await this.downloadLanguageServer()
        }

        // Make sure the server is executable
        if (plat.operatingSystem !== OperatingSystem.Windows) {
            fs.chmodSync(this.languageServerExe, "755")
        }

        return this.languageServerExe
    }

    public getLanguageServerVersion(): string {
        return this.loadLocalDownloadInfo().version
    }

    shouldRegularUpdate(): boolean {
        let thres = 7 * 86400000
        let info = this.loadLocalDownloadInfo()
        if (!info) return true
        let diff = new Date(Date.now() - info.downloadedTime)
        return diff.getTime() >= thres
    }
}

